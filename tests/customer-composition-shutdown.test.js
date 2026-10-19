import assert from 'node:assert/strict';
import test from 'node:test';

import { shutdownCustomerRuntime } from '../src/customer-shutdown.js';

test('customer composition gracefully closes HTTP before persistence', async () => {
  const events = [];
  const server = {
    close(callback) {
      events.push('http');
      callback();
    },
    closeAllConnections: () => events.push('forced'),
  };

  await shutdownCustomerRuntime({
    server,
    persistence: { close: async () => events.push('persistence') },
    started: true,
    timeoutMs: 25,
  });

  assert.deepEqual(events, ['http', 'persistence']);
});

test('customer composition force-closes hung HTTP connections at the deadline', async () => {
  const events = [];
  const server = {
    close() {
      events.push('http');
    },
    closeAllConnections: () => events.push('forced'),
  };

  await assert.rejects(shutdownCustomerRuntime({
    server,
    persistence: { close: async () => events.push('persistence') },
    started: true,
    timeoutMs: 25,
  }), /CUSTOMER_SHUTDOWN_TIMEOUT/);

  assert.deepEqual(events, ['http', 'forced', 'persistence']);
});

test('customer composition still closes persistence when HTTP close fails', async () => {
  const events = [];
  const server = {
    close(callback) {
      events.push('http');
      callback(new Error('HTTP_CLOSE_FAILED'));
    },
    closeAllConnections: () => events.push('forced'),
  };

  await assert.rejects(shutdownCustomerRuntime({
    server,
    persistence: { close: async () => events.push('persistence') },
    started: true,
    timeoutMs: 25,
  }), /HTTP_CLOSE_FAILED/);

  assert.deepEqual(events, ['http', 'persistence']);
});


test('customer shutdown waits for active job fact custody before HTTP and persistence close', async () => {
  const events = []; let finish;
  const stopped = shutdownCustomerRuntime({ jobWorker: { async stop() {
    events.push('job-stopping'); await new Promise((resolve) => { finish = resolve; }); events.push('job-stopped');
  } }, server: { close(callback) { events.push('http'); callback(); } },
  persistence: { close: async () => events.push('persistence') }, started: true, timeoutMs: 25 });
  await Promise.resolve(); assert.deepEqual(events, ['job-stopping']); finish(); await stopped;
  assert.deepEqual(events, ['job-stopping','job-stopped','http','persistence']);
});

test('job shutdown failure still closes HTTP and persistence and is not acknowledged as success', async () => {
  const events = [];
  await assert.rejects(shutdownCustomerRuntime({ jobWorker: { async stop() { throw new Error('SYNTHETIC_JOB_STOP_FAILED'); } },
    server: { close(callback) { events.push('http'); callback(); } },
    persistence: { close: async () => events.push('persistence') }, started: true, timeoutMs: 25 }), /SYNTHETIC_JOB_STOP_FAILED/);
  assert.deepEqual(events, ['http','persistence']);
});
