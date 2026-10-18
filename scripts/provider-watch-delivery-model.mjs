// Isolated acceptance model only. No runtime import, account adapter or mail transport.
const RETRY_WINDOW_MS = 86_400_000;

function requireCondition(value) {
  if (!value) throw new TypeError('PROVIDER_WATCH_MODEL_INVALID');
}

function exact(value, keys) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}

function instant(value) {
  requireCondition(typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value);
  return Date.parse(value);
}

function token(value) {
  requireCondition(typeof value === 'string' && /^[a-z0-9-]{1,128}$/.test(value));
}

function validateState(state) {
  exact(state, ['schemaVersion', 'pending', 'deliveries']);
  requireCondition(state.schemaVersion === 1 && Array.isArray(state.deliveries) && state.deliveries.length <= 50);
  for (const record of state.deliveries) {
    exact(record, ['key', 'sendId', 'status']); token(record.key); token(record.sendId);
    requireCondition(['accepted', 'delivered', 'failed', 'bounced', 'delayed'].includes(record.status));
  }
  requireCondition(new Set(state.deliveries.map((item) => item.key)).size === state.deliveries.length);
  if (state.pending !== null) {
    exact(state.pending, ['key', 'digest', 'createdAt', 'sendId']);
    token(state.pending.key); instant(state.pending.createdAt);
    requireCondition(typeof state.pending.digest === 'string' && /^[a-f0-9]{64}$/.test(state.pending.digest));
    if (state.pending.sendId !== null) token(state.pending.sendId);
    requireCondition(!state.deliveries.some((item) => item.key === state.pending.key));
  }
}

// Ports are supplied exclusively by the fixture runner. No transport is created here.
export async function runIsolatedProviderWatchAttempt({ event, ledger, transport, clock }) {
  exact(event, ['key', 'digest']); token(event.key);
  requireCondition(typeof event.digest === 'string' && /^[a-f0-9]{64}$/.test(event.digest));
  let previousClock = -Infinity;
  const now = () => {
    const value = clock();
    requireCondition(Number.isSafeInteger(value) && value >= previousClock);
    previousClock = value;
    return value;
  };
  const read = async () => {
    const state = await ledger.read(); validateState(state); now();
    return structuredClone(state);
  };
  const persist = async (state) => {
    validateState(state);
    await ledger.write(structuredClone(state));
    const stored = await read();
    requireCondition(JSON.stringify(stored) === JSON.stringify(state));
    return stored;
  };
  let state = await read();
  const recorded = state.deliveries.find((item) => item.key === event.key);
  if (recorded) return { action: 'already_recorded', status: recorded.status };
  if (state.pending !== null) {
    requireCondition(state.pending.key === event.key && state.pending.digest === event.digest);
  } else {
    // Never discard a suppression receipt merely to admit another synthetic event.
    requireCondition(state.deliveries.length < 50);
    state.pending = { ...event, createdAt: new Date(now()).toISOString(), sendId: null };
    state = await persist(state);
  }
  const age = () => {
    const elapsed = now() - instant(state.pending.createdAt);
    requireCondition(elapsed >= 0);
    return elapsed;
  };
  if (state.pending.sendId === null) {
    // Recheck after all asynchronous persistence, immediately before the external-port call.
    if (age() >= RETRY_WINDOW_MS) return { action: 'manual_reconciliation_required' };
    const receipt = await transport.send(structuredClone(state.pending));
    exact(receipt, ['sendId']); token(receipt.sendId);
    state.pending.sendId = receipt.sendId;
    state = await persist(state);
  } else age();
  const delivery = await transport.lookup(state.pending.sendId);
  exact(delivery, ['sendId', 'status']); token(delivery.sendId);
  requireCondition(delivery.sendId === state.pending.sendId
    && ['accepted', 'delivered', 'failed', 'bounced', 'delayed'].includes(delivery.status));
  // Provider acceptance suppresses repeat warnings even when later delivery fails.
  state.deliveries.push({ key: event.key, ...delivery });
  state.pending = null;
  await persist(state);
  return { action: 'recorded', status: delivery.status };
}
