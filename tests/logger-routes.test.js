import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger } from '../src/logger.js';

const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

function loggedRoute(route, method) {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  logger.requestCompleted({
    requestId: REQUEST_ID,
    method,
    route,
    statusCode: 200,
    durationMs: 1,
  });
  return JSON.parse(lines.at(-1));
}

test('Tenant user administration uses bounded operational route labels', () => {
  assert.equal(loggedRoute('tenant_users', 'GET').route, 'tenant_users');
  assert.equal(loggedRoute('tenant_user_roles', 'PUT').route, 'tenant_user_roles');
});

test('operational logger still rejects arbitrary dynamic route labels', () => {
  const logger = createLogger({ write: () => {} });
  assert.throws(() => logger.requestCompleted({
    requestId: REQUEST_ID,
    method: 'GET',
    route: '/api/v1/tenant/users/attacker-controlled',
    statusCode: 200,
    durationMs: 1,
  }), /LOG_ROUTE_INVALID/);
});
