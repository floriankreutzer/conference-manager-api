import { Agent, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setMaxListeners } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { normalizeRequestCompositionDraft } from '../src/domain/request-composition.js';

// Test-only protocol measurement: the destination and operation cannot be supplied remotely.
async function measureRequests({ origin, cookies, verify, concurrency = 16, deadlineMs = 45_000,
  arrivalIntervalMs = 0 }, path, writes = null) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !url.port) throw new Error('LOAD_DESTINATION_INVALID');
  if (!Array.isArray(cookies) || cookies.length < 1 || cookies.length > 10_000
    || cookies.some((cookie) => !/^cm_session=[A-Za-z0-9_-]{43}$/.test(cookie))) throw new Error('LOAD_COOKIES_INVALID');
  if (typeof verify !== 'function' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32
    || !Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 60_000) throw new Error('LOAD_BOUNDS_INVALID');
  if (!Number.isInteger(arrivalIntervalMs) || arrivalIntervalMs < 0 || arrivalIntervalMs > 1_000
    || (cookies.length - 1) * arrivalIntervalMs >= deadlineMs) throw new Error('LOAD_ARRIVAL_INVALID');
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
  const started = performance.now();
  const latencies = [];
  const scheduledLatencies = [];
  const scheduleLags = [];
  let next = 0;
  let payloadBytes = 0;
  let requestPayloadBytes = 0;
  let failed = false;
  const controller = new AbortController();
  // Only this private, bounded signal: HTTP cancellation and paced workers can temporarily overlap.
  setMaxListeners(concurrency * 2 + 2, controller.signal);
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  async function execute(index) {
    const scheduledAt = started + index * arrivalIntervalMs;
    if (arrivalIntervalMs) {
      while (performance.now() < scheduledAt) {
        await wait(Math.ceil(scheduledAt - performance.now()), undefined, { signal: controller.signal });
      }
    }
    controller.signal.throwIfAborted();
    const at = performance.now();
    const payload = writes?.[index];
    const result = await new Promise((resolve, reject) => {
      const req = request(new URL(Array.isArray(path) ? path[index] : path, url), {
        agent, signal: controller.signal, method: payload ? 'POST' : 'GET',
        headers: { Cookie: cookies[index], ...(payload ? {
          Origin: url.origin, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload.body), 'X-CSRF-Token': payload.csrfToken,
          ...(payload.expectedVersion ? { 'If-Match': `"${payload.expectedVersion}"` } : {}),
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
            if (response.statusCode !== (payload?.expectedStatus ?? (payload ? 201 : 200))) throw new Error('LOAD_STATUS_INVALID');
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
    const completedAt = performance.now();
    latencies.push(completedAt - at);
    if (arrivalIntervalMs) {
      scheduledLatencies.push(completedAt - scheduledAt);
      scheduleLags.push(at - scheduledAt);
    }
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
    function distribution(values) {
      values.sort((a, b) => a - b);
      const percentile = fraction => Number(values[Math.ceil(values.length * fraction) - 1].toFixed(3));
      return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
    }
    const elapsedMs = performance.now() - started;
    return Object.freeze({ requests: cookies.length, concurrency, payloadBytes,
      ...(writes ? { requestPayloadBytes } : {}),
      elapsedMs: Number(elapsedMs.toFixed(3)), requestsPerSecond: Number((cookies.length * 1_000 / elapsedMs).toFixed(3)),
      latencyMs: distribution(latencies),
      ...(arrivalIntervalMs ? { arrivalIntervalMs,
        offeredRequestsPerSecond: Number((1_000 / arrivalIntervalMs).toFixed(3)),
        scheduledLatencyMs: distribution(scheduledLatencies), scheduleLagMs: distribution(scheduleLags) } : {}) });
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

// Reads only canonical synthetic UUIDs on the fixed Request route; no caller-selected URL or method.
export async function measureRequestReads({ requestIds, ...options }) {
  if (!Array.isArray(options.cookies) || options.cookies.length < 1 || options.cookies.length > 1_000
    || !Array.isArray(requestIds) || requestIds.length !== options.cookies.length
    || requestIds.some(id => typeof id !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))) {
    throw new Error('LOAD_READ_INPUT_INVALID');
  }
  return measureRequests(options, requestIds.map(id => '/api/v1/requests/' + id));
}

// Two fixed synthetic manager phases only. No confirmation/provider work or retry.
export async function measureRequestTransitions({ requestIds, csrfTokens, transition, ...options }) {
  if (!['start_review', 'reject'].includes(transition)
    || !Array.isArray(options.cookies) || options.cookies.length < 1 || options.cookies.length > 1_000
    || !Array.isArray(requestIds) || requestIds.length !== options.cookies.length
    || requestIds.some(id => typeof id !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))
    || new Set(requestIds).size !== requestIds.length
    || !Array.isArray(csrfTokens) || csrfTokens.length !== requestIds.length
    || csrfTokens.some(token => typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))) {
    throw new Error('LOAD_TRANSITION_INPUT_INVALID');
  }
  const body = JSON.stringify(transition === 'reject'
    ? { transition, reason: 'Synthetic isolated load decision' } : { transition });
  const writes = csrfTokens.map(csrfToken => ({ body, csrfToken, expectedStatus: 200,
    expectedVersion: transition === 'start_review' ? 1 : 2 }));
  return measureRequests(options, requestIds.map(id => `/api/v1/requests/${id}/transitions`), writes);
}

// A fixed existing Room and canonical UTC slot; no resubmission selector or arbitrary URL.
export async function measureRoomAvailability({ startsAt, endsAt, csrfTokens, ...options }) {
  const start = Date.parse(startsAt); const end = Date.parse(endsAt);
  if (typeof startsAt !== 'string' || typeof endsAt !== 'string'
    || !Number.isFinite(start) || !Number.isFinite(end)
    || new Date(start).toISOString() !== startsAt || new Date(end).toISOString() !== endsAt
    || end <= start || end - start > 86400000
    || !Array.isArray(options.cookies) || options.cookies.length > 1000
    || !Array.isArray(csrfTokens) || csrfTokens.length !== options.cookies.length
    || csrfTokens.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))) {
    throw new Error('LOAD_AVAILABILITY_INVALID');
  }
  const body = JSON.stringify({ roomId: 'room', startsAt, endsAt });
  return measureRequests(options, '/api/v1/application/room-availability',
    csrfTokens.map(csrfToken => ({ csrfToken, body, expectedStatus: 200 })));
}
