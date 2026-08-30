import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import {
  assertPlatformRouteKey,
  PLATFORM_HTTP_ROUTE,
} from '../src/platform/http/observability.js';

test('shared metrics registry accepts only the injected bounded Platform route vocabulary', () => {
  const metrics = createMetricsRegistry({ assertRouteKey: assertPlatformRouteKey });
  for (const route of Object.values(PLATFORM_HTTP_ROUTE)) {
    metrics.recordApiRequest({ route, method: 'GET', statusCode: 200, durationMs: 1 });
  }
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.length, Object.values(PLATFORM_HTTP_ROUTE).length);
  assert.ok(snapshot.counters.every((entry) => entry.labels.route.startsWith('platform_')));
  assert.throws(
    () => metrics.recordApiRequest({
      route: 'platform_tenant_11111111-1111-4111-8111-111111111111',
      method: 'GET',
      statusCode: 200,
      durationMs: 1,
    }),
    /PLATFORM_ROUTE_KEY_INVALID/,
  );
});

test('shared metrics registry retains the Customer route vocabulary by default', () => {
  const metrics = createMetricsRegistry();
  metrics.recordApiRequest({ route: 'health_live', method: 'GET', statusCode: 200, durationMs: 1 });
  assert.throws(
    () => metrics.recordApiRequest({
      route: PLATFORM_HTTP_ROUTE.HEALTH_LIVE,
      method: 'GET',
      statusCode: 200,
      durationMs: 1,
    }),
    /METRIC_ROUTE_INVALID/,
  );
});
