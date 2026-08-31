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
