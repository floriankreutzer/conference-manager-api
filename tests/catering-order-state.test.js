import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canDecideCateringOrderQuote, canRecordCateringOrderQuote, capabilityForCateringOrderOperation, isCateringOrderStatus,
} from '../src/domain/catering-order-state.js';

test('quote editing and decisions stop before delivery/reconciliation facts can be overwritten', () => {
  assert.equal(canRecordCateringOrderQuote('pending_quote'), true);
  assert.equal(canDecideCateringOrderQuote('pending_quote'), false);
  for (const status of ['pending_manager_review','rejected','released']) {
    assert.equal(canRecordCateringOrderQuote(status), true);
    assert.equal(canDecideCateringOrderQuote(status), true);
  }
  for (const status of ['queued','dispatching','reconciliation_required','transmitted','confirmed','partially_confirmed',
    'cancelled','failed',
    'delivered', undefined, null, true, {}]) {
    assert.equal(canRecordCateringOrderQuote(status), false);
    assert.equal(canDecideCateringOrderQuote(status), false);
  }
});
test('operation capability remains explicit and unknown/prototype values cannot select an adapter method', () => {
  assert.equal(capabilityForCateringOrderOperation('initial'), 'catering.order');
  assert.equal(capabilityForCateringOrderOperation('change'), 'catering.update');
  assert.equal(capabilityForCateringOrderOperation('cancel'), 'catering.cancel');
  assert.equal(capabilityForCateringOrderOperation('exception'), 'catering.update');
  for (const value of ['automatic','toString','__proto__',undefined,null]) assert.throws(() => capabilityForCateringOrderOperation(value));
  assert.equal(isCateringOrderStatus('confirmed'), true);
  assert.equal(isCateringOrderStatus('delivered'), false);
});
