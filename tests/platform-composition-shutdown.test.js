import assert from 'node:assert/strict';
import test from 'node:test';

import { closePlatformHttpServerWithinDeadline } from '../src/platform/index.js';

test('Platform process gracefully closes HTTP before its deadline', async () => {
  const events = [];
  const server = {
    close(callback) {
      events.push('http');
      callback();
    },
    closeAllConnections: () => events.push('forced'),
  };

  await closePlatformHttpServerWithinDeadline(server, 25);

  assert.deepEqual(events, ['http']);
});

test('Platform process force-closes hung HTTP connections at its deadline', async () => {
  const events = [];
  const server = {
    close() {
      events.push('http');
    },
    closeAllConnections: () => events.push('forced'),
  };

  await assert.rejects(
    closePlatformHttpServerWithinDeadline(server, 25),
    /PLATFORM_SHUTDOWN_TIMEOUT/,
  );

  assert.deepEqual(events, ['http', 'forced']);
});

test('Platform process reports synchronous HTTP close failures', async () => {
  const server = {
    close() {
      throw new Error('HTTP_CLOSE_FAILED');
    },
    closeAllConnections() {},
  };

  await assert.rejects(
    closePlatformHttpServerWithinDeadline(server, 25),
    /HTTP_CLOSE_FAILED/,
  );
});
