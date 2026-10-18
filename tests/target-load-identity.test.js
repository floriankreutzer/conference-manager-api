import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createLoadPlatformAuthentication } from '../scripts/support/target-load-identity.mjs';
import { loadTargetRuntimeConfig } from '../scripts/support/target-load-runtime-config.mjs';
import { createPlatformComposition } from '../src/platform-composition.js';
import { createPostgresPlatformPersistence } from '../src/persistence/postgres/platform-index.js';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import { assertPlatformRouteKey } from '../src/platform/http/observability.js';
import { targetLoopbackJson } from './support/target-load-http.js';
import { targetLoadEnvironment, NOW } from './support/target-load-environment.js';

test('canonical Platform HTTP boot retains its authentication contract while target identity operations stay unavailable', async t => {
  const { config } = loadTargetRuntimeConfig(targetLoadEnvironment('platform'), NOW);
  const persistence = createPostgresPlatformPersistence(config); let databaseCalls = 0;
  persistence.pool.query = () => { databaseCalls += 1; throw new Error('FORBIDDEN_DATABASE_CALL'); };
  persistence.pool.connect = () => { databaseCalls += 1; throw new Error('FORBIDDEN_DATABASE_CALL'); };
  const metrics = createMetricsRegistry({ assertRouteKey: assertPlatformRouteKey });
  const composition = createPlatformComposition({ config, persistence, metrics,
    authenticationFactory: createLoadPlatformAuthentication });
  const server = composition.process.server;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await composition.stop();
  });
  // Exercise the real HTTP server without starting its independent PostgreSQL worker.
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = new URL(config.publicOrigin).host;
  for (const path of ['/api/v1/platform/auth/microsoft/login',
    `/api/v1/platform/auth/microsoft/callback?state=${'a'.repeat(43)}&code=synthetic-code`]) {
    const response = await targetLoopbackJson(server, path, host);
    assert.equal(response.status, 503); assert.equal(response.headers.location, undefined);
    assert.equal(response.body.error.code, 'PLATFORM_IDENTITY_UNAVAILABLE');
  }
  assert.equal(databaseCalls, 0);
  assert.ok(metrics.snapshot().counters.some(row => row.metric === 'api_requests_total' && row.value > 0));
});
