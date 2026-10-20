import { ApiError } from '../api-error.js';
import {
  applySecurityHeaders,assertAllowedMethod,assertRequestHost,assertSafeRequestTarget,assertSameOrigin,
  createRateLimiter,createRequestId,
} from '../security.js';
import { ProtectedRuntimeGateError } from '../persistence/postgres/protected-runtime-gate.js';
import { ROOM_IMAGE_INPUT_MAX_BYTES } from '../media/room-image-processor.js';

const MEDIA_UPLOAD=/^\/api\/v1\/tenant\/rooms\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/media$/;

function configuration(config,surface) {
  if (!['customer','platform'].includes(surface) || !config || config.demoRuntime || config.mode==='demo'
    || !Number.isSafeInteger(config.maxBodyBytes) || config.maxBodyBytes<1 || config.maxBodyBytes>1_048_576
    || !Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs<1_000
    || config.requestTimeoutMs>120_000
    || !Number.isSafeInteger(config.rateLimitMax) || config.rateLimitMax<1 || config.rateLimitMax>10_000
    || !Number.isSafeInteger(config.rateLimitWindowMs) || config.rateLimitWindowMs<1_000
    || config.rateLimitWindowMs>3_600_000
    || (config.rateLimitMaxKeys!==undefined && (!Number.isSafeInteger(config.rateLimitMaxKeys)
      || config.rateLimitMaxKeys<1 || config.rateLimitMaxKeys>10_000))) {
    throw new TypeError('PROTECTED_HTTP_EXECUTION_CONFIGURATION_INVALID');
  }
  let origin;
  try { origin=new URL(config.publicOrigin); } catch { /* The closed check below owns this error. */ }
  if (!origin || origin.protocol!=='https:' || origin.origin!==config.publicOrigin
    || origin.username || origin.password) throw new TypeError('PROTECTED_HTTP_EXECUTION_CONFIGURATION_INVALID');
  return Object.freeze({ ...config });
}

function failure(response,config,error) {
  if (response.writableEnded) return;
  if (response.headersSent) { response.destroy();return; }
  const requestId=createRequestId();
  const recognized=error instanceof ApiError;
  const unavailable=error instanceof ProtectedRuntimeGateError;
  const code=recognized ? error.code : unavailable ? 'PROTECTED_RUNTIME_UNAVAILABLE' : 'INTERNAL_ERROR';
  const status=recognized ? error.statusCode : unavailable ? 503 : 500;
  applySecurityHeaders(response,config);
  const body=JSON.stringify({ error: { code,requestId } });
  response.removeHeader('Set-Cookie');
  response.statusCode=status;
  response.setHeader('X-Request-Id',requestId);
  response.setHeader('Connection','close');
  response.setHeader('Content-Type','application/json; charset=utf-8');
  response.setHeader('Content-Length',Buffer.byteLength(body));
  response.end(body);
}

// Buffer the bounded transport bytes before any database lease or Principal is
// resolved. Existing route readers receive a separate, single-use read view;
// neither IncomingMessage nor its iterator is patched, and no body is parsed or
// made authoritative here. Route content-type/schema/CSRF checks remain intact.
function stageBody(request,maxBytes,timeoutMs) {
  const length=request.headers['content-length'];
  if (length!==undefined && (typeof length!=='string' || !/^\d+$/.test(length))) {
    throw new ApiError(400,'CONTENT_LENGTH_INVALID');
  }
  if (length!==undefined && Number(length)>maxBytes) throw new ApiError(413,'BODY_TOO_LARGE');
  const encoding=request.headers['content-encoding'];
  if (encoding!==undefined && encoding!=='identity') throw new ApiError(415,'CONTENT_ENCODING_NOT_ALLOWED');
  return new Promise((resolve,reject)=>{
    const chunks=[];let bytes=0,settled=false;
    function cleanup() {
      clearTimeout(timer);
      for (const [event,listener] of listeners) request.removeListener(event,listener);
    }
    function finish(error) {
      if (settled) return;settled=true;cleanup();
      if (error) { request.pause();reject(error);return; }
      const buffer=Buffer.concat(chunks,bytes);let consumed=false;
      resolve(Object.freeze({ method: request.method,url: request.url,
        headers: Object.freeze({ ...request.headers }),socket: request.socket,
        async *[Symbol.asyncIterator]() {
          if (consumed) throw new TypeError('PROTECTED_HTTP_BODY_ALREADY_READ');
          consumed=true;if (buffer.length) yield buffer;
        },
      }));
    }
    const listeners=[['data',chunk=>{
      if (!Buffer.isBuffer(chunk)) { finish(new ApiError(400,'REQUEST_BODY_INVALID'));return; }
      bytes+=chunk.length;
      if (bytes>maxBytes) { finish(new ApiError(413,'BODY_TOO_LARGE'));return; }
      chunks.push(chunk);
    }],['end',()=>finish(length!==undefined && Number(length)!==bytes
      ? new ApiError(400,'CONTENT_LENGTH_INVALID') : null)],
    ['aborted',()=>finish(new ApiError(400,'REQUEST_BODY_INCOMPLETE'))],
    ['error',()=>finish(new ApiError(400,'REQUEST_BODY_INCOMPLETE'))]];
    const timer=setTimeout(()=>finish(new ApiError(408,'REQUEST_BODY_TIMEOUT')),timeoutMs);
    timer.unref();
    for (const [event,listener] of listeners) request.on(event,listener);
  });
}

// This transport does not authenticate, grant a Tenant, or implement an exclusive
// operation. The owned root must supply the actual current deployment scope and
// canonical app. Only the two exact proof-completion routes omit its outer shared
// lease: their protocols own preparation and the actual exclusive transaction.
export function createProtectedHttpExecutionHandler({ config,surface,executionScopes,app,platformBoundary=null }={}) {
  const fixed=configuration(config,surface);
  if ((surface==='platform' && (typeof platformBoundary?.validate!=='function'
    || typeof platformBoundary?.ownsExclusiveCompletion!=='function' || typeof platformBoundary?.mapError!=='function'))
    || (surface==='customer' && platformBoundary!==null)) {
    throw new TypeError('PROTECTED_HTTP_EXECUTION_CONFIGURATION_INVALID');
  }
  if (typeof executionScopes?.withShared!=='function' || typeof app!=='function') {
    throw new TypeError('PROTECTED_HTTP_EXECUTION_CONFIGURATION_INVALID');
  }
  const limiter=createRateLimiter({ max: fixed.rateLimitMax,windowMs: fixed.rateLimitWindowMs,
    maxKeys: fixed.rateLimitMaxKeys });
  return async function handle(request,response) {
    try {
      if (surface==='platform') {
        platformBoundary.validate(request,fixed.publicOrigin);
      } else {
        assertAllowedMethod(request.method);assertSafeRequestTarget(request.url);
        assertRequestHost(request.headers,fixed.publicOrigin);assertSameOrigin(request.headers,fixed.publicOrigin);
      }
      const url=new URL(request.url,fixed.publicOrigin),path=url.pathname;
      const health=surface==='platform' ? '/api/v1/platform/health/' : '/api/v1/health/';
      const probe=request.method==='GET' && url.search==='' && ['live','ready','status'].some(name=>path===health+name);
      if (!(probe && path===health+'live')) limiter.consume(request.socket.remoteAddress || 'unknown');
      const maxBytes=surface==='customer' && request.method==='POST' && MEDIA_UPLOAD.test(path)
        ? ROOM_IMAGE_INPUT_MAX_BYTES : fixed.maxBodyBytes;
      const staged=await stageBody(request,maxBytes,fixed.requestTimeoutMs);
      if (response.destroyed) return;
      if (probe || (surface==='platform' && request.method==='POST' && platformBoundary.ownsExclusiveCompletion(path))) {
        await app(staged,response);return;
      }
      // Includes session resolution, Tenant context, all business reads/writes,
      // nested providers, audit and response construction, not just service work.
      await executionScopes.withShared(()=>app(staged,response));
    } catch (error) { failure(response,fixed,platformBoundary?.mapError(error) || error); }
  };
}
