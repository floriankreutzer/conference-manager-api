import { versionProposal } from './support/catering-version-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cateringVersionProposalBasis, normalizeCateringVersionCommand, normalizeCateringVersionProposal,
} from '../src/domain/catering-version-proposal.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const command = () => ({ schemaVersion: 1, commandId: id(7), expectedOrderVersion: 1, expectedStateRevision: 5,
  expectedRequestVersion: 2, expectedAssignmentRevision: 1, operation: 'change', justification: 'Synthetic changed schedule' });
const basis = (extra = {}) => ({ operation: 'change', headVersion: 1, headStatus: 'confirmed',
  effective: { orderVersion: 1, status: 'confirmed' }, currentRequestVersion: 2, currentRequestStatus: 'Confirmed',
  effectiveRequestVersion: 1, effectiveAssignmentRevision: 1, ...extra });

test('an attested withdrawn order without supplier commitment restarts as a reviewed first physical order', () => {
  for (const currentRequestVersion of [1,2]) {
    const plan = cateringVersionProposalBasis(basis({ effective: null, headStatus: 'withdrawn', currentRequestVersion }));
    assert.equal(plan.eligible, true); assert.equal(plan.deliveryOperation, 'initial');
    assert.equal(plan.basisOrderVersion, 1); assert.equal(plan.nextOrderVersion, 2);
    assert.equal(plan.sourceRequestVersion, currentRequestVersion);
  }
  for (const extra of [{ operation: 'cancel' }, { operation: 'exception' }, { currentRequestStatus: 'Cancelled' },
    ...['pending_quote','rejected','failed','transmitted','partially_confirmed','reconciliation_required']
      .map((headStatus) => ({ headStatus }))]) {
    assert.equal(cateringVersionProposalBasis(basis({ effective: null, headStatus: 'withdrawn', ...extra })).eligible, false);
  }
  assert.throws(() => cateringVersionProposalBasis(basis({ effective: null, headStatus: 'withdrawn',
    effectiveRequestVersion: 3 })), /INVALID/);
  const retained = cateringVersionProposalBasis(basis({ headVersion: 2, headStatus: 'withdrawn' }));
  assert.equal(retained.basisOrderVersion, 1); assert.equal(retained.nextOrderVersion, 3);
  assert.equal(Object.hasOwn(retained, 'deliveryOperation'), false);
});

test('version proposals require explicit bounded justification and exact immutable source CAS', () => {
  const value = normalizeCateringVersionCommand(command(), { orderId: id(5) });
  assert.equal(Object.isFrozen(value), true); assert.equal(value.orderId, id(5));
  for (const extra of [{ schemaVersion: 2 }, { commandId: 'foreign' }, { expectedOrderVersion: Number.MAX_SAFE_INTEGER - 1 },
    { expectedStateRevision: 0 }, { expectedRequestVersion: '2' }, { expectedAssignmentRevision: 0 }, { operation: 'initial' },
    { justification: '' }, { justification: ' untrimmed' }, { justification: 'x'.repeat(1001) }, { justification: 'line\nbreak' },
    { actorUserId: id(99) }, { cost: { amountMinor: 0, currency: 'EUR' } }]) {
    assert.throws(() => normalizeCateringVersionCommand({ ...command(), ...extra }, { orderId: id(5) }), /INVALID/);
  }
  let reads = 0; const getter = command();
  Object.defineProperty(getter, 'operation', { enumerable: true, get() { reads++; return 'change'; } });
  assert.throws(() => normalizeCateringVersionCommand(getter, { orderId: id(5) }), /INVALID/); assert.equal(reads, 0);
});

test('replacement uses the approved current Request while cancellation/exception retain confirmed commercial basis', () => {
  assert.deepEqual(cateringVersionProposalBasis(basis()), { eligible: true, source: 'current_request', basisOrderVersion: 1,
    sourceRequestVersion: 2, basisAssignmentRevision: 1, requestEvidenceVersion: 2, requestEvidenceStatus: 'Confirmed',
    nextOrderVersion: 2 });
  for (const operation of ['cancel','exception']) {
    const currentRequestVersion = operation === 'exception' ? 1 : 2;
    const value = cateringVersionProposalBasis(basis({ operation, currentRequestVersion }));
    assert.equal(value.source, 'effective_order'); assert.equal(value.sourceRequestVersion, 1);
    assert.equal(value.requestEvidenceVersion, operation === 'exception' ? 1 : 2); assert.equal(value.nextOrderVersion, 2);
  }
  const cancelled = cateringVersionProposalBasis(basis({ operation: 'cancel', currentRequestStatus: 'Cancelled' }));
  assert.equal(cancelled.eligible, true); assert.equal(cancelled.requestEvidenceStatus, 'Cancelled');
});

test('unknown or partial prior delivery cannot authorize overlapping replacements or imply caterer cancellation', () => {
  for (const headStatus of ['pending_quote','pending_manager_review','released','queued','dispatching','reconciliation_required',
    'transmitted','partially_confirmed','cancelled']) {
    assert.equal(cateringVersionProposalBasis(basis({ headStatus })).reason, 'prior_version_unresolved');
  }
  assert.equal(cateringVersionProposalBasis(basis({ effective: null })).reason, 'confirmed_order_required');
  assert.equal(cateringVersionProposalBasis(basis({ effective: { orderVersion: 1, status: 'cancelled' } })).reason,
    'order_already_cancelled');
  for (const operation of ['change','exception']) {
    assert.equal(cateringVersionProposalBasis(basis({ operation, currentRequestStatus: 'Cancelled' })).reason, 'conference_not_confirmed');
  }
  assert.equal(cateringVersionProposalBasis(basis({ currentRequestVersion: 1 })).reason, 'request_change_required');
  assert.equal(cateringVersionProposalBasis(basis({ operation: 'exception' })).reason, 'request_change_required');
  for (const headStatus of ['rejected','failed']) {
    assert.equal(cateringVersionProposalBasis(basis({ headVersion: 2, headStatus })).nextOrderVersion, 3);
  }
  assert.equal(cateringVersionProposalBasis(basis({ headVersion: 2 })).reason, 'prior_version_unresolved');
  for (const extra of [{ effective: { orderVersion: 2, status: 'confirmed' } }, { effectiveRequestVersion: 3 },
    { currentRequestStatus: 'Draft' }, { operation: 'initial' }, { tenantId: id(99) }]) {
    assert.throws(() => cateringVersionProposalBasis(basis(extra)), /INVALID/);
  }
});

test('stored proposal normalizer rejects foreign, private, nonconsecutive and mismatched source records before projection', () => {
  const scope = { tenantId: id(1), orderId: id(5) };
  assert.equal(normalizeCateringVersionProposal(versionProposal(), scope).orderVersion, 2);
  for (const extra of [{ tenantId: id(99) }, { orderId: id(99) }, { orderVersion: 3 }, { priorOrderVersion: 0 },
    { basisOrderVersion: 2 }, { requestId: '../foreign' }, { sourceRequestVersion: 1 }, { requestEvidenceStatus: 'Cancelled' },
    { proposedAt: '2026-02-30T15:00:00.000Z' }, { actorPayload: 'private' }]) {
    assert.throws(() => normalizeCateringVersionProposal(versionProposal(2, extra), scope), /INVALID/);
  }
  let reads = 0; const getter = versionProposal();
  Object.defineProperty(getter, 'justification', { enumerable: true, get() { reads++; return 'private'; } });
  assert.throws(() => normalizeCateringVersionProposal(getter, scope), /INVALID/); assert.equal(reads, 0);
});
