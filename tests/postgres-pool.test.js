import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';

function config(applicationName, demoRuntime = false) {
  return {
    mode: 'test',
    databaseUrl: 'postgresql://test:test@localhost:5432/conference_manager_test',
    databaseSsl: 'disable',
    databasePoolMax: 1,
    databaseConnectionTimeoutMs: 100,
    databaseIdleTimeoutMs: 100,
    databaseStatementTimeoutMs: 100,
    ...(demoRuntime ? { demoRuntime: true } : {}),
    ...(applicationName === undefined ? {} : { applicationName }),
  };
}

test('PostgreSQL pool application name is a fixed customer or Platform identity', async () => {
  const customer = createPostgresPool(config());
  const platform = createPostgresPool(config('conference-manager-platform-api'));
  try {
    assert.equal(customer.options.application_name, 'conference-manager-api');
    assert.equal(platform.options.application_name, 'conference-manager-platform-api');
    assert.throws(() => createPostgresPool(config('browser-selected-name')), {
      message: 'DATABASE_APPLICATION_NAME_INVALID',
    });
  } finally {
    await customer.end();
    await platform.end();
  }
});

test('Demo-only pool identities require the explicit Demo runtime marker', async () => {
  assert.throws(() => createPostgresPool(config('conference-manager-demo-reset')), {
    message: 'DATABASE_APPLICATION_NAME_INVALID',
  });
  const reset = createPostgresPool(config('conference-manager-demo-reset', true));
  try {
    assert.equal(reset.options.application_name, 'conference-manager-demo-reset');
  } finally {
    await reset.end();
  }
});
