import { fileURLToPath } from 'node:url';
import { ApiError } from './api-error.js';
import { applySecurityHeaders,assertRequestHost,assertSafeRequestTarget,assertSameOrigin,createRateLimiter } from './security.js';
import { readProtectedFrontendArtifact } from './protected-frontend-artifact.js';

export async function loadProtectedHostedFrontend(profile) {
  if (profile.hostedFrontendSha256===null) return null;
  if (!['customer','platform'].includes(profile.surface)) throw new TypeError('PROTECTED_FRONTEND_ARTIFACT_INVALID');
  const root=fileURLToPath(new URL(`../.protected-frontend/${profile.surface}/`,import.meta.url));
  return readProtectedFrontendArtifact(root,profile);
}

// The closed roots select this fixed implementation. API targets always retain
// the whole protected transport/authentication/lease pipeline, including errors.
export function withProtectedHostedFrontend({ profile,config,artifact,apiHandler }) {
  if (artifact===null) return apiHandler;
  // Native-module cold navigations request the whole sealed graph. Admit up
  // to sixteen such loads/minute/address, capped independently of API limits.
  const limiter=createRateLimiter({ max: Math.min(4096,artifact.fileCount*16),windowMs: 60_000,maxKeys: 2000 });
  return (request,response)=>{
    if (typeof request.url!=='string' || /^\/api(?:\/|\?|$)/.test(request.url)) return apiHandler(request,response);
    try {
      assertRequestHost(request.headers,config.publicOrigin);assertSafeRequestTarget(request.url);
      assertSameOrigin(request.headers,config.publicOrigin);
      if (!['GET','HEAD'].includes(request.method)) throw new ApiError(405,'METHOD_NOT_ALLOWED');
      if (request.headers['transfer-encoding']!==undefined || request.headers['content-encoding']!==undefined
        || request.headers['content-length']!==undefined && request.headers['content-length']!=='0') {
        throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
      }
      limiter.consume(request.socket.remoteAddress ?? 'unknown');
      const url=new URL(request.url,config.publicOrigin);
      let name=decodeURIComponent(url.pathname).slice(1);
      applySecurityHeaders(response,config);
      if (profile.surface==='platform' && !name) {
        response.writeHead(303,{ Location: '/platform-admin/' });response.end();return;
      }
      if (profile.surface==='customer' && !name || profile.surface==='platform' && name==='platform-admin/') name=artifact.entry;
      const file=artifact.get(name);if (!file) throw new ApiError(404,'NOT_FOUND');
      response.setHeader('Content-Security-Policy',artifact.csp);
      response.setHeader('Referrer-Policy','same-origin');
      response.writeHead(200,{ 'Content-Type': file.type,'Content-Length': file.bytes.length });
      response.end(request.method==='HEAD' ? undefined : file.bytes);
    } catch (error) {
      applySecurityHeaders(response,config);response.setHeader('Connection','close');
      response.statusCode=error instanceof ApiError ? error.statusCode : 400;response.end();
    }
  };
}
