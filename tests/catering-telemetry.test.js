import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import { cateringConfigurationRouteKey } from '../src/http/settings/catering-integrations.js';
import { cateringCatalogueAssignmentRouteKey } from '../src/http/catering-catalogue-assignments.js';
import { cateringOrderRouteKey } from '../src/http/catering-orders.js';
import { cateringDeliveryRouteKey } from '../src/http/catering-delivery-jobs.js';
import { cateringManualRouteKey } from '../src/http/catering-manual-delivery.js';

const ID = '11111111-1111-4111-8111-111111111111';
test('all closed Catering routes retain bounded completion metrics without object identifiers', () => {
  const root = '/api/v1/tenant/catering';
  const keys = [cateringConfigurationRouteKey('/api/v1/integrations/catering'),
    cateringConfigurationRouteKey(`/api/v1/integrations/catering/${ID}/configuration`),
    cateringCatalogueAssignmentRouteKey(`${root}/catalogue-assignments`),
    cateringCatalogueAssignmentRouteKey(`${root}/catalogue-connections`),
    ...['',`/${ID}`,`/${ID}/quote`,`/${ID}/decision`].map((suffix) => cateringOrderRouteKey(`${root}/orders${suffix}`)),
    ...['',`/${ID}`].map((suffix) => cateringDeliveryRouteKey(`${root}/delivery-jobs${suffix}`)),
    cateringManualRouteKey(`${root}/orders/${ID}/manual-delivery`)];
  const metrics = createMetricsRegistry();
  for (const route of keys) {
    assert.equal(typeof route, 'string');
    metrics.recordApiRequest({ route, method: 'GET', statusCode: 200, durationMs: 1 });
  }
  const snapshot = JSON.stringify(metrics.snapshot());
  assert.equal(metrics.snapshot().counters.length, 11); assert.doesNotMatch(snapshot, new RegExp(ID));
  assert.throws(() => metrics.recordApiRequest({ route: `catering_delivery_${ID}`, method: 'GET', statusCode: 200, durationMs: 1 }));
});
