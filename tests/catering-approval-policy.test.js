import assert from 'node:assert/strict';
import test from 'node:test';
import { cateringReviewRequirement } from '../src/domain/catering-approval-policy.js';

test('only an initial order can use the provider-specific conference-approval mode', () => {
  assert.equal(cateringReviewRequirement('after_conference_approval', 'initial'), 'conference_approval');
  assert.equal(cateringReviewRequirement('manager_review', 'initial'), 'manager_review');
  for (const mode of ['after_conference_approval', 'manager_review']) {
    for (const operation of ['change', 'cancel', 'exception']) {
      assert.equal(cateringReviewRequirement(mode, operation), 'manager_review');
    }
  }
});

test('missing or unknown approval modes and operations cannot default to automatic release', () => {
  for (const mode of [undefined, null, '', 'automatic', true, {}]) {
    assert.throws(() => cateringReviewRequirement(mode, 'initial'), /APPROVAL_POLICY_INVALID/);
  }
  for (const operation of [undefined, null, '', 'conference_cancel', true, {}]) {
    assert.throws(() => cateringReviewRequirement('after_conference_approval', operation), /APPROVAL_POLICY_INVALID/);
  }
});
