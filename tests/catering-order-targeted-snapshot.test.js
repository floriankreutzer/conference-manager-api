import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringOrderSnapshots } from '../src/domain/catering-order-snapshot.js';
import { cateringId, cateringOrderFixture } from './support/catering-order-fixture.js';

test('historical detail reconstructs only the scoped provider/version without fabricating other identities', () => {
  const source = cateringOrderFixture();
  const factory = source.positionIdFactory;
  let positions = 0;
  source.positionIdFactory = (context) => {
    assert.equal(context.integrationId, cateringId(4));
    assert.equal(context.orderVersion, 2);
    positions++;
    return factory(context);
  };
  const result = createCateringOrderSnapshots({ ...source, onlyIntegrationId: cateringId(4), orderVersion: 2 });
  assert.equal(result.length, 1);
  assert.equal(result[0].orderVersion, 2);
  assert.equal(result[0].integrationId, cateringId(4));
  assert.equal(result[0].conferencePrice.amountMinor, 200);
  assert.equal(positions, 1);
});

test('target selection does not waive full ownership/source validation or accept an unknown provider', () => {
  for (const extra of [{ onlyIntegrationId: cateringId(99) }, { onlyIntegrationId: 'external' }, { orderVersion: 0 }]) {
    assert.throws(() => createCateringOrderSnapshots({ ...cateringOrderFixture(), ...extra }));
  }
  const source = cateringOrderFixture();
  source.ownership.assignments[0].integrationId = cateringId(4);
  assert.throws(() => createCateringOrderSnapshots({ ...source, onlyIntegrationId: cateringId(4) }), /PROVIDER_MISMATCH/);
});
