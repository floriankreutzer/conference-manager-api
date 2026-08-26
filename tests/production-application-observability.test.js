import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../src/logger.js';
import { createMetricsRegistry } from '../src/observability/metrics.js';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ROUTES = Object.freeze([
  ['application_profile', 'GET'],
  ['application_catalog', 'GET'],
  ['application_site_info', 'GET'],
  ['application_requests', 'POST'],
  ['application_room_availability', 'POST'],
  ['application_notifications', 'GET'],
  ['application_notification', 'PATCH'],
  ['application_configuration', 'PUT'],
]);
const MICROSOFT365_ROUTES = Object.freeze([
  ['microsoft365_free_busy_verify', 'POST'],
  ['microsoft365_pilot_readiness', 'GET'],
]);

test('every production application route has bounded logger and metric vocabulary', () => {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)) });
  const metrics = createMetricsRegistry();

  for (const [route, method] of ROUTES) {
    logger.requestCompleted({
      requestId: REQUEST_ID,
      route,
      method,
      statusCode: 200,
      durationMs: 1,
    });
    metrics.recordApiRequest({ route, method, statusCode: 200, durationMs: 1 });
  }

  assert.deepEqual(lines.map((entry) => entry.route), ROUTES.map(([route]) => route));
  const snapshot = JSON.stringify(metrics.snapshot());
  for (const [route] of ROUTES) assert.match(snapshot, new RegExp(route));
  assert.doesNotMatch(snapshot, new RegExp(REQUEST_ID));
});

test('Pilot verification and readiness routes have bounded logger and metric vocabulary', () => {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)) });
  const metrics = createMetricsRegistry();
  for (const [route, method] of MICROSOFT365_ROUTES) {
    logger.requestCompleted({
      requestId: REQUEST_ID,
      route,
      method,
      statusCode: 200,
      durationMs: 1,
    });
    metrics.recordApiRequest({ route, method, statusCode: 200, durationMs: 1 });
  }
  assert.deepEqual(lines.map((entry) => entry.route), MICROSOFT365_ROUTES.map(([route]) => route));
  const snapshot = JSON.stringify(metrics.snapshot());
  for (const [route] of MICROSOFT365_ROUTES) assert.match(snapshot, new RegExp(route));
});
