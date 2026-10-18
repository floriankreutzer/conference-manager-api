import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const DAY = 86_400_000;
const STATUSES = ['accepted', 'delivered', 'failed', 'bounced', 'delayed'];
const THRESHOLDS = [50, 70, 85, 95];

function requireValid(value) {
  if (!value) throw new TypeError('PROVIDER_WATCH_INVALID');
}

function exact(value, keys) {
  requireValid(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}

function token(value) {
  requireValid(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value));
}

function instant(value) {
  requireValid(typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value);
  return Date.parse(value);
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function payload(value, policy) {
  exact(value, ['from', 'to', 'subject', 'text']);
  requireValid(value.from === policy.from && value.subject === policy.subject
    && Array.isArray(value.to) && value.to.length === 1 && value.to[0] === policy.to
    && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 16_384);
  return { from: value.from, to: [...value.to], subject: value.subject, text: value.text };
}

function event(value, policy) {
  exact(value, ['idempotencyKey', 'payload', 'acknowledgements']); token(value.idempotencyKey);
  const normalized = { idempotencyKey: value.idempotencyKey, payload: payload(value.payload, policy), acknowledgements: [] };
  requireValid(Array.isArray(value.acknowledgements) && value.acknowledgements.length > 0 && value.acknowledgements.length <= 3);
  const sources = new Set();
  normalized.acknowledgements = value.acknowledgements.map((item) => {
    exact(item, ['source', 'windowStart', 'windowEnd', 'thresholds']); instant(item.windowEnd);
    requireValid(['neon', 'resend.daily', 'resend.monthly'].includes(item.source) && !sources.has(item.source));
    if (item.source === 'neon') requireValid(instant(item.windowStart) < instant(item.windowEnd));
    else requireValid(item.windowStart === null);
    sources.add(item.source);
    requireValid(Array.isArray(item.thresholds) && item.thresholds.length > 0 && item.thresholds.length <= 4
      && item.thresholds.every((level, index) => THRESHOLDS.includes(level)
        && (index === 0 || level > item.thresholds[index - 1])));
    return { source: item.source, windowStart: item.windowStart, windowEnd: item.windowEnd, thresholds: [...item.thresholds] };
  });
  return normalized;
}

function validateState(value, policy) {
  requireValid(value && typeof value === 'object' && !Array.isArray(value) && value.schemaVersion === 1
    && Object.hasOwn(value, 'pending') && Array.isArray(value.deliveries) && value.deliveries.length <= 50
    && Buffer.byteLength(JSON.stringify(value)) <= 131_072);
  const keys = new Set();
  for (const receipt of value.deliveries) {
    token(receipt.idempotencyKey); token(receipt.sendId);
    requireValid(STATUSES.includes(receipt.status) && !keys.has(receipt.idempotencyKey));
    keys.add(receipt.idempotencyKey);
    if (receipt.protocolVersion !== undefined) {
      exact(receipt, ['protocolVersion', 'idempotencyKey', 'payloadSha256', 'eventSha256', 'createdAt', 'sendId', 'status']);
      requireValid(receipt.protocolVersion === 1 && /^[a-f0-9]{64}$/.test(receipt.payloadSha256)
        && /^[a-f0-9]{64}$/.test(receipt.eventSha256)); instant(receipt.createdAt);
    }
  }
  if (value.pending !== null && value.pending.protocolVersion === 1) {
    const pending = value.pending;
    exact(pending, ['protocolVersion', 'event', 'payloadSha256', 'eventSha256', 'createdAt', 'sendId']);
    const normalized = event(pending.event, policy);
    requireValid(!keys.has(normalized.idempotencyKey) && pending.payloadSha256 === hash(normalized.payload)
      && pending.eventSha256 === hash(normalized));
    instant(pending.createdAt);
    if (pending.sendId !== null) token(pending.sendId);
  } else requireValid(value.pending === null || (typeof value.pending === 'object' && !Array.isArray(value.pending)));
}

function acknowledge(state, pending, requireCurrentWindow = false) {
  for (const item of pending.event.acknowledgements) {
    const target = item.source === 'neon' ? state.neon : state.resend?.[item.source.split('.')[1]];
    const windowStart = item.source === 'neon' ? target?.periodStart : null;
    const windowEnd = item.source === 'neon' ? target?.periodEnd : target?.resetAt;
    const sameWindow = windowStart === item.windowStart && windowEnd === item.windowEnd;
    if (requireCurrentWindow) requireValid(sameWindow);
    // A recovered old-window receipt must never mark thresholds in a new window.
    if (!sameWindow) continue;
    requireValid(Array.isArray(target.reportedThresholds)
      && target.reportedThresholds.every((level) => THRESHOLDS.includes(level)));
    target.reportedThresholds = [...new Set([...target.reportedThresholds, ...item.thresholds])].sort((a, b) => a - b);
  }
}

// The connector CLI and fault tests execute this same runner. Ports never contain URLs or credentials.
// ledger.write must compare the complete expected snapshot under an exclusive adapter execution.
export async function runProviderWatchDelivery({ warning, policy, ledger, transport, clock }) {
  exact(policy, ['from', 'to', 'subject']);
  requireValid(typeof policy.from === 'string' && policy.from.length > 0 && policy.from.length <= 320
    && !/[\r\n]/.test(policy.from)
    && typeof policy.to === 'string' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(policy.to) && policy.to.length <= 254
    && typeof policy.subject === 'string' && policy.subject.length > 0 && policy.subject.length <= 200
    && !/[\r\n]/.test(policy.subject));
  const incoming = warning === null ? null : event(warning, policy);
  let previousClock = -Infinity;
  const now = () => {
    const time = clock(); requireValid(Number.isSafeInteger(time) && time >= 0 && time >= previousClock);
    previousClock = time; return time;
  };
  const read = async () => {
    const state = structuredClone(await ledger.read()); validateState(state, policy); now(); return state;
  };
  let state = await read();
  const persist = async (next) => {
    validateState(next, policy);
    await ledger.write({ expected: structuredClone(state), next: structuredClone(next) });
    const stored = await read();
    requireValid(isDeepStrictEqual(stored, next)); state = stored;
  };
  if (state.pending !== null && state.pending.protocolVersion !== 1) {
    return { action: 'manual_reconciliation_required', reason: 'legacy_pending' };
  }
  if (state.pending !== null && incoming !== null) {
    requireValid(isDeepStrictEqual(state.pending.event, incoming));
  }
  if (state.pending === null) {
    if (incoming === null) return { action: 'no_signal' };
    const recorded = state.deliveries.find((item) => item.idempotencyKey === incoming.idempotencyKey);
    if (recorded) {
      if (recorded.protocolVersion !== 1) return { action: 'legacy_receipt', status: recorded.status };
      requireValid(recorded.payloadSha256 === hash(incoming.payload) && recorded.eventSha256 === hash(incoming));
      return { action: 'already_recorded', status: recorded.status };
    }
    requireValid(state.deliveries.length < 50);
    const next = structuredClone(state);
    next.pending = { protocolVersion: 1, event: incoming, payloadSha256: hash(incoming.payload),
      eventSha256: hash(incoming), createdAt: new Date(now()).toISOString(), sendId: null };
    // Validate acknowledgement targets before any external side effect, without marking them yet.
    acknowledge(structuredClone(next), next.pending, true);
    await persist(next);
  }
  let age = now() - instant(state.pending.createdAt); requireValid(age >= 0);
  if (state.pending.sendId === null) {
    if (age >= DAY) return { action: 'manual_reconciliation_required', reason: 'retry_window_expired' };
    // Re-read immediately before send; adapters must reject concurrent execution, never blind-overwrite.
    const fresh = await read(); requireValid(isDeepStrictEqual(fresh, state));
    age = now() - instant(state.pending.createdAt); requireValid(age >= 0);
    if (age >= DAY) return { action: 'manual_reconciliation_required', reason: 'retry_window_expired' };
    const response = await transport.send({ idempotencyKey: state.pending.event.idempotencyKey,
      ...structuredClone(state.pending.event.payload) });
    exact(response, ['sendId']); token(response.sendId);
    const next = structuredClone(state); next.pending.sendId = response.sendId; await persist(next);
  }
  const delivery = await transport.lookup(state.pending.sendId);
  exact(delivery, ['sendId', 'status']); token(delivery.sendId);
  requireValid(delivery.sendId === state.pending.sendId && STATUSES.includes(delivery.status));
  const next = structuredClone(state);
  acknowledge(next, next.pending);
  next.deliveries.push({ protocolVersion: 1, idempotencyKey: next.pending.event.idempotencyKey,
    payloadSha256: next.pending.payloadSha256, eventSha256: next.pending.eventSha256,
    createdAt: next.pending.createdAt, ...delivery });
  next.pending = null;
  await persist(next);
  return { action: 'recorded', status: delivery.status };
}
