import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { loadTargetOrigin, loadTargetScope } from './target-load-guard.mjs';

function valid(value) { if (!value) throw new Error('LOAD_TARGET_HTTP_FAILED'); }
function route(input) {
  valid(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => ['kind', 'actor', 'path', 'method', 'cookie', 'binary',
      'signal', 'body', 'csrfToken', 'expectedVersion'].includes(key)));
  const get = input.method === 'GET'; const post = input.method === 'POST';
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  valid(typeof input.path === 'string' && input.path.length <= 2200);
  const allowed = {
    session_read: get && input.path === '/api/v1/session',
    room_page_read: get
      && /^\/api\/v1\/application\/catalog\?section=rooms&limit=5&(?:context|cursor)=[A-Za-z0-9_-]{1,2048}$/.test(input.path),
    media_read: get && new RegExp(`^/api/v1/tenant/rooms/room/media/${uuid}$`).test(input.path),
    availability_lookup: post && input.path === '/api/v1/application/room-availability',
    request_create: post && input.path === '/api/v1/application/requests',
    request_read: get && new RegExp(`^/api/v1/requests/${uuid}$`).test(input.path),
    request_transition: post && new RegExp(`^/api/v1/requests/${uuid}/transitions$`).test(input.path),
  };
  valid(Object.hasOwn(allowed, input.kind) && allowed[input.kind]);
  valid(input.binary === (input.kind === 'media_read'));
  valid(/^cm_session=[A-Za-z0-9_-]{43}$/.test(input.cookie));
  if (post) valid(typeof input.csrfToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.csrfToken));
  if (input.kind === 'request_transition') valid([1, 2].includes(input.expectedVersion));
  else valid(input.expectedVersion === undefined);
  valid(post ? input.body !== undefined : input.body === undefined);
}

// A single campaign's private, fixed HTTPS edge. There is no redirect, retry,
// proxy, URL/Host override, provider SDK or database authority in this module.
// recordAttempt MUST durably reserve the fixed aggregate before network I/O.
export function createTargetLoadTransport({ values, origins, recordAttempt, clock = Date.now,
  monotonic = performance.now.bind(performance), request = https.request } = {}) {
  try {
    const scope = loadTargetScope(values, clock());
    valid(typeof recordAttempt === 'function' && typeof request === 'function' && scope.surface === 'setup');
    const fixed = Object.fromEntries(['customer', 'platform'].map(surface => [surface,
      loadTargetOrigin(origins?.[surface], scope.runId, surface)]));
    let previous = clock(); let closed = false; let inFlight = 0; let attempts = 0; let reservedBytes = 0;
    let reservation = Promise.resolve(); const cold = new Set();
    function active() {
      const now = clock();
      if (!Number.isSafeInteger(now) || now < previous || now >= scope.expiresMs - 60_000) closed = true;
      previous = now; valid(!closed);
    }
    async function send({ surface, path, method, body, headers, binary, kind, signal, timeoutMs = 5000, expectedStatus }) {
      active(); valid(signal instanceof AbortSignal); signal.throwIfAborted();
      const limit = binary ? 2 * 1024 * 1024 : 8192;
      valid(inFlight < 16 && attempts < 10_000 && reservedBytes + limit <= 2_000_000_000);
      valid(body === undefined || Buffer.byteLength(body) <= 8192);
      inFlight += 1; attempts += 1; reservedBytes += limit;
      const ordinal = attempts; const at = monotonic();
      try {
        reservation = reservation.then(async () => {
          active(); signal.throwIfAborted();
          await recordAttempt(Object.freeze({ ordinal, surface, kind, method, responseByteReservation: limit,
            requestPayloadBytes: body === undefined ? 0 : Buffer.byteLength(body) })); active();
        });
        try { await reservation; } catch { closed = true; throw new Error('LOAD_TARGET_HTTP_FAILED'); }
        active(); signal.throwIfAborted();
        return await new Promise((resolve, reject) => {
          let settled = false; let timer; let req;
          function fail() {
            if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
            req?.destroy(); reject(new Error('LOAD_TARGET_HTTP_FAILED'));
          }
          function abort() { fail(); }
          signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(fail, timeoutMs);
          try {
            const url = new URL(path, fixed[surface]);
            valid(url.origin === fixed[surface] && !url.hash && !url.username && !url.password);
            req = request(url, { method, headers: { ...headers, 'Accept': binary ? 'image/webp' : 'application/json',
              'Accept-Encoding': 'identity', 'Connection': 'close',
              ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) },
            agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, response => {
              try {
                active(); valid(Number.isInteger(response.statusCode)
                  && (expectedStatus === undefined ? response.statusCode >= 200 && response.statusCode < 300
                    : response.statusCode === expectedStatus) && response.headers.location === undefined
                  && response.headers['content-encoding'] === undefined);
                valid(binary ? response.headers['content-type'] === 'image/webp'
                  : /^application\/json(?:; charset=utf-8)?$/i.test(response.headers['content-type'] ?? ''));
                const length = response.headers['content-length'];
                valid(length === undefined || (/^[0-9]+$/.test(length) && Number(length) <= limit));
              } catch { response.destroy(); fail(); return; }
              const chunks = []; let size = 0;
              response.on('data', chunk => {
                size += chunk.length;
                if (size > limit) { response.destroy(); fail(); } else chunks.push(Buffer.from(chunk));
              });
              response.once('error', fail); response.once('aborted', fail);
              response.once('end', () => {
                if (settled) return;
                try {
                  active(); signal.throwIfAborted(); const bytes = Buffer.concat(chunks);
                  const result = binary ? bytes : JSON.parse(bytes.toString('utf8'));
                  const latencyMs = monotonic() - at; valid(Number.isFinite(latencyMs) && latencyMs >= 0 && latencyMs <= 60_000);
                  settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
                  resolve({ status: response.statusCode, body: result, payloadBytes: bytes.length,
                    requestPayloadBytes: body === undefined ? 0 : Buffer.byteLength(body), latencyMs });
                } catch { fail(); }
              });
            });
            req.once('error', fail); req.end(body);
          } catch { fail(); }
        });
      } finally { inFlight -= 1; }
    }
    return Object.freeze({
      async exchange(input) {
        try {
          route(input);
          const headers = { Cookie: input.cookie };
          if (input.method === 'POST') Object.assign(headers, { Origin: fixed.customer,
            'Content-Type': 'application/json', 'X-CSRF-Token': input.csrfToken,
            ...(input.expectedVersion === undefined ? {} : { 'If-Match': `"${input.expectedVersion}"` }) });
          return await send({ surface: 'customer', headers, path: input.path, method: input.method,
            kind: input.kind, binary: input.binary, signal: input.signal,
            body: input.body === undefined ? undefined : JSON.stringify(input.body) });
        } catch { throw new Error('LOAD_TARGET_HTTP_FAILED'); }
      },
      async observe(surface, signal) {
        try {
          valid(['customer', 'platform'].includes(surface));
          return await send({ surface, path: '/__load/observe', method: 'GET', binary: false,
            headers: { Authorization: `Bearer ${scope.observerToken}` }, kind: 'observer_read', signal });
        } catch { throw new Error('LOAD_TARGET_HTTP_FAILED'); }
      },
      async coldObserve(surface, signal) {
        try {
          valid(['customer', 'platform'].includes(surface) && !cold.has(surface) && attempts === cold.size);
          cold.add(surface);
          return await send({ surface, path: '/__load/observe', method: 'GET', binary: false, timeoutMs: 60_000,
            headers: { Authorization: `Bearer ${scope.observerToken}` }, kind: 'observer_cold_read', signal });
        } catch { throw new Error('LOAD_TARGET_HTTP_FAILED'); }
      },
      async negativeProbe(input) {
        try {
          valid(input && Object.keys(input).every(key => ['probe', 'requestId', 'cookie', 'csrfToken', 'signal'].includes(key))
            && ['foreign_read', 'missing_csrf', 'stale_version'].includes(input.probe));
          const read = input.probe === 'foreign_read';
          const method = read ? 'GET' : 'POST';
          const path = `/api/v1/requests/${input.requestId}${read ? '' : '/transitions'}`;
          const body = read ? undefined : { transition: 'confirm' };
          route({ kind: read ? 'request_read' : 'request_transition', path, method, cookie: input.cookie, binary: false,
            body, expectedVersion: read ? undefined : 2, csrfToken: input.probe === 'missing_csrf' ? '0'.repeat(43) : input.csrfToken });
          const headers = { Cookie: input.cookie, ...(read ? {} : { Origin: fixed.customer,
            'Content-Type': 'application/json', 'If-Match': '"2"',
            ...(input.probe === 'missing_csrf' ? {} : { 'X-CSRF-Token': input.csrfToken }) }) };
          const response = await send({ surface: 'customer', path, method, headers, binary: false,
            kind: `negative_${input.probe}`, signal: input.signal, body: body === undefined ? undefined : JSON.stringify(body),
            expectedStatus: read ? 404 : input.probe === 'missing_csrf' ? 403 : 409 });
          valid(typeof response.body?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(response.body.error.code));
          return { status: response.status, payloadBytes: response.payloadBytes,
            requestPayloadBytes: response.requestPayloadBytes, latencyMs: response.latencyMs };
        } catch { throw new Error('LOAD_TARGET_HTTP_FAILED'); }
      },
      close() { closed = true; },
      snapshot() { return Object.freeze({ attempts, reservedResponseBytes: reservedBytes, inFlight, closed }); },
    });
  } catch { throw new Error('LOAD_TARGET_HTTP_FAILED'); }
}
