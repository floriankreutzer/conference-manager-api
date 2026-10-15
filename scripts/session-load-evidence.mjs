import { Agent, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { normalizeRequestCompositionDraft } from '../src/domain/request-composition.js';

// Test-only protocol measurement: the destination and operation cannot be supplied remotely.
async function measureRequests({ origin, cookies, verify, concurrency = 16, deadlineMs = 45_000 }, path, writes = null) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !url.port) throw new Error('LOAD_DESTINATION_INVALID');
  if (!Array.isArray(cookies) || cookies.length < 1 || cookies.length > 10_000
    || cookies.some((cookie) => !/^cm_session=[A-Za-z0-9_-]{43}$/.test(cookie))) throw new Error('LOAD_COOKIES_INVALID');
  if (typeof verify !== 'function' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32
    || !Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 60_000) throw new Error('LOAD_BOUNDS_INVALID');
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
  const started = performance.now();
  const latencies = [];
  let next = 0;
  let payloadBytes = 0;
  let requestPayloadBytes = 0;
  let failed = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  async function execute(index) {
    const at = performance.now();
    const payload = writes?.[index];
    const result = await new Promise((resolve, reject) => {
      const req = request(new URL(path, url), {
        agent, signal: controller.signal, method: payload ? 'POST' : 'GET',
        headers: { Cookie: cookies[index], ...(payload ? {
          Origin: url.origin, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload.body), 'X-CSRF-Token': payload.csrfToken,
        } : {}) },
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 8_192) response.destroy(new Error('LOAD_RESPONSE_TOO_LARGE'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            if (response.statusCode !== (payload ? 201 : 200)) throw new Error('LOAD_STATUS_INVALID');
            resolve({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes });
          } catch { reject(new Error('LOAD_RESPONSE_INVALID')); }
        });
      });
      req.on('error', () => reject(new Error('LOAD_REQUEST_FAILED')));
      req.setTimeout(5_000, () => req.destroy());
      req.end(payload?.body);
    });
    verify(result.body, index);
    payloadBytes += result.bytes;
    requestPayloadBytes += payload ? Buffer.byteLength(payload.body) : 0;
    latencies.push(performance.now() - at);
  }
  try {
    const workers = Array.from({ length: Math.min(concurrency, cookies.length) }, async () => {
      while (!failed && next < cookies.length) {
        const index = next++;
        try { await execute(index); } catch { failed = true; controller.abort(); throw new Error('LOAD_ACCEPTANCE_FAILED'); }
      }
    });
    const outcomes = await Promise.allSettled(workers);
    if (outcomes.some((outcome) => outcome.status === 'rejected') || latencies.length !== cookies.length) {
      throw new Error('LOAD_ACCEPTANCE_FAILED');
    }
    latencies.sort((a, b) => a - b);
    const percentile = (fraction) => Number(latencies[Math.ceil(latencies.length * fraction) - 1].toFixed(3));
    const elapsedMs = performance.now() - started;
    return Object.freeze({ requests: cookies.length, concurrency, payloadBytes,
      ...(writes ? { requestPayloadBytes } : {}),
      elapsedMs: Number(elapsedMs.toFixed(3)), requestsPerSecond: Number((cookies.length * 1_000 / elapsedMs).toFixed(3)),
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) } });
  } finally { clearTimeout(timer); controller.abort(); agent.destroy(); }
}

export function measureSessionReads(options) {
  return measureRequests(options, '/api/v1/session');
}

// The caller can select only a bounded catalogue generation, never a destination, route or page size.
export async function measureCatalogRoomReads({ context, cursor, ...options }) {
  if (cursor !== undefined) {
    if (context !== undefined || typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) {
      throw new Error('LOAD_CURSOR_INVALID');
    }
    return measureRequests(options, `/api/v1/application/catalog?section=rooms&limit=5&cursor=${cursor}`);
  }
  if (typeof context !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(context)) {
    throw new Error('LOAD_CONTEXT_INVALID');
  }
  return measureRequests(options, `/api/v1/application/catalog?section=rooms&limit=5&context=${context}`);
}

// Only canonical v3 creates, at most 1,000 synthetic operations; no caller-selected method or route.
export async function measureRequestCreates({ drafts, csrfTokens, ...options }) {
  if (!Array.isArray(options.cookies) || options.cookies.length < 1 || options.cookies.length > 1_000
    || !Array.isArray(drafts) || drafts.length !== options.cookies.length
    || !Array.isArray(csrfTokens) || csrfTokens.length !== drafts.length
    || csrfTokens.some(token => typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))) {
    throw new Error('LOAD_WRITE_INPUT_INVALID');
  }
  let writes;
  try {
    writes = drafts.map((draft, index) => {
      const body = JSON.stringify({ schemaVersion: 3, request: normalizeRequestCompositionDraft(draft, 3) });
      if (Buffer.byteLength(body) > 8_192) throw new Error('LOAD_WRITE_INPUT_INVALID');
      return { body, csrfToken: csrfTokens[index] };
    });
  } catch { throw new Error('LOAD_WRITE_INPUT_INVALID'); }
  return measureRequests(options, '/api/v1/application/requests', writes);
}
