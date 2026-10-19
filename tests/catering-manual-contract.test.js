import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCateringManualCommand, normalizeCateringManualFact } from '../src/domain/catering-manual-contract.js';

const id = (n) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const occurredAt = '2026-10-19T13:00:00.000Z';
const command = () => ({ schemaVersion: 1, commandId: id(4), expectedOrderVersion: 1, expectedStateRevision: 4,
  kind: 'transmitted', channel: 'telephone', reference: 'Synthetic conversation #1', occurredAt, receipt: null });
const receipt = () => ({ orderId: id(2), orderVersion: 1, positions: [{ positionId: id(3), outcome: 'confirmed' }] });
const scope = { tenantId: id(1), orderId: id(2), orderVersion: 1 };
function fact() {
  return { ...scope, sequence: 1, commandId: id(4), originStateRevision: 4, kind: 'transmitted', channel: 'telephone',
    reference: 'Synthetic conversation #1', occurredAt, recordedAt: '2026-10-19T13:01:00.000Z', actorUserId: id(5),
    actorSecurityVersion: 1, quoteRevision: 1, decisionSequence: 1, operation: 'initial', status: 'transmitted', receipt: null };
}

test('manual command accepts bounded explicit attestation details without client Tenant/actor/cost authority', () => {
  for (const channel of ['email','telephone','portal','in_person','other']) {
    const value = { ...command(), channel };
    assert.deepEqual(normalizeCateringManualCommand(value, scope), { ...value, orderId: scope.orderId });
  }
  for (const mutate of [(v) => { v.tenantId = id(8); }, (v) => { v.actorUserId = id(8); }, (v) => { v.cost = 100; },
    (v) => { v.schemaVersion = 2; }, (v) => { v.expectedOrderVersion = 0; }, (v) => { v.expectedStateRevision = Number.MAX_SAFE_INTEGER; },
    (v) => { v.channel = 'webhook'; }, (v) => { v.kind = 'send'; }, (v) => { v.reference = 'https://synthetic.invalid'; },
    (v) => { v.reference = '=formula'; }, (v) => { v.reference = ' x '; }, (v) => { v.reference = 'x'.repeat(201); },
    (v) => { v.occurredAt = '2026-02-30T13:00:00.000Z'; }, (v) => { v.receipt = receipt(); }]) {
    const value = command(); mutate(value); assert.throws(() => normalizeCateringManualCommand(value, scope), /INVALID/);
  }
});

test('manual receipt is structurally scoped, bounded, immutable and never contains replacement cost or substitution acceptance', () => {
  const value = { ...command(), kind: 'receipt', receipt: receipt() };
  const normalized = normalizeCateringManualCommand(value, scope);
  assert.equal(Object.isFrozen(normalized.receipt.positions[0]), true);
  assert.equal(normalized.receipt.positions[0].outcome, 'confirmed');
  for (const mutate of [(v) => { v.receipt.cost = 100; }, (v) => { v.receipt.orderId = id(9); },
    (v) => { v.receipt.orderVersion = 2; }, (v) => { v.receipt.positions = []; },
    (v) => { v.receipt.positions.push(v.receipt.positions[0]); }, (v) => { v.receipt.positions[0].outcome = 'substitution_accepted'; },
    (v) => { v.receipt.positions[0].replacement = 'unapproved'; }, (v) => { delete v.receipt.positions[0]; }]) {
    const bad = structuredClone(value); mutate(bad); assert.throws(() => normalizeCateringManualCommand(bad, scope), /INVALID/);
  }
  let reads = 0; const getter = command();
  Object.defineProperty(getter, 'reference', { enumerable: true, get() { reads++; return 'unsafe'; } });
  assert.throws(() => normalizeCateringManualCommand(getter, scope), /INVALID/); assert.equal(reads, 0);
});

test('stored manual facts require independent scope and exact derived state, retaining server actor/origin only internally', () => {
  const value = fact(); assert.deepEqual(normalizeCateringManualFact(value, scope), value);
  const acknowledged = { ...value, kind: 'receipt', receipt: receipt(), status: 'confirmed' };
  assert.equal(normalizeCateringManualFact(acknowledged, scope).status, 'confirmed');
  const proposed = { ...acknowledged, status: 'transmitted', receipt: { ...receipt(), positions: [
    { positionId: id(3), outcome: 'substitution_proposed' },
  ] } };
  assert.equal(normalizeCateringManualFact(proposed, scope).status, 'transmitted');
  for (const mutate of [(v) => { v.tenantId = id(9); }, (v) => { v.orderVersion = 2; }, (v) => { v.status = 'confirmed'; },
    (v) => { v.recordedAt = '2026-10-18T13:00:00.000Z'; }, (v) => { v.actorUserId = null; }, (v) => { v.rawPayload = 'private'; }]) {
    const bad = fact(); mutate(bad); assert.throws(() => normalizeCateringManualFact(bad, scope), /INVALID/);
  }
});
