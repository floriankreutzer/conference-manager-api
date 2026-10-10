import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { startDemoEntrypointRuntime } from '../src/demo/entrypoint-runtime.js';
import { createDemoPlatformComposition } from '../src/demo/platform-composition.js';
import { trafficFixture, NOW, listen, request, deferred } from './support/demo-traffic-gate-fixture.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function scheduler() {
  const timers = [];
  return { timers, schedule(callback, delay) {
    const timer = { callback, delay, cancelled: false, unref() {} };
    timers.push(timer);
    return timer;
  }, cancel(timer) { if (timer) timer.cancelled = true; } };
}

for (const surface of ['customer', 'platform']) {
  test(`${surface} closed and expired startup never invokes the active factory`, async () => {
    for (const mode of ['closed', 'acceptance']) {
      const fixture = trafficFixture(surface, mode, mode === 'acceptance' ? {
        DEMO_TRAFFIC_ACCEPTANCE_EXPIRES_AT: new Date(NOW - 1).toISOString(),
      } : {});
      let closed = 0;
      const runtime = await startDemoEntrypointRuntime({ ...fixture,
        startActive() { throw new Error('ACTIVE_FACTORY_FORBIDDEN'); },
        onExpiryFailure() { assert.fail('Unexpected expiry failure'); },
      }, { clock: () => NOW, async startClosed({ trafficGate }) {
        closed += 1;
        assert.ok(['closed', 'expired'].includes(trafficGate.state()));
        return { async stop() {} };
      } });
      assert.equal(closed, 1);
      await runtime.stop();
    }
  });

  test(`${surface} closed startup retains pure media-storage pin validation`, async () => {
    const fixture = trafficFixture(surface, 'closed', { DEMO_MEDIA_STORAGE_DATABASE_HOST: 'wrong.invalid' });
    await assert.rejects(startDemoEntrypointRuntime({ ...fixture,
      startActive() { assert.fail('Active startup'); }, onExpiryFailure() {},
    }, { clock: () => NOW, startClosed() { assert.fail('Invalid configuration must not listen'); } }), /DEMO_MEDIA_/);
  });
}

test('expiry is armed before pending startup and fails process before late worker activation', async () => {
  const fixture = trafficFixture();
  const startup = deferred();
  const scheduled = scheduler();
  const events = [];
  let trafficGate;
  const promise = startDemoEntrypointRuntime({ ...fixture,
    startActive(gate) { trafficGate = gate; events.push('startup'); return startup.promise; },
    onExpiryFailure(error) { events.push(error.message); },
  }, { ...scheduled, clock: () => NOW, startClosed() { assert.fail('Failed bootstrap must not be green'); } });
  assert.equal(scheduled.timers.length, 1);
  assert.equal(scheduled.timers[0].delay, 60_000);
  scheduled.timers[0].callback();
  assert.equal(trafficGate.state(), 'draining');
  assert.deepEqual(events, ['startup', 'DEMO_TRAFFIC_SHUTDOWN_FAILED']);
  startup.resolve({ async stop() { events.push('late-runtime-stopped'); } });
  await assert.rejects(promise, /DEMO_TRAFFIC_START_FAILED/);
  assert.equal(events.at(-1), 'late-runtime-stopped');
});

test('expiry keeps HTTP deployment probe red until active stop has completed', async (t) => {
  const fixture = trafficFixture('platform');
  const stopping = deferred();
  const closedStarted = deferred();
  const scheduled = scheduler();
  let trafficGate;
  let closed = 0;
  const runtime = await startDemoEntrypointRuntime({ ...fixture,
    async startActive(gate) { trafficGate = gate; return { stop: () => stopping.promise }; },
    onExpiryFailure() { assert.fail('Stop should succeed'); },
  }, { ...scheduled, clock: () => NOW, async startClosed() {
    closed += 1;
    closedStarted.resolve();
    return { async stop() {} };
  } });
  const port = await listen(t, http.createServer((req, res) => trafficGate.handle(req, res)));
  scheduled.timers[0].callback();
  const probe = await request(port, 'platform', '/api/v1/platform/health/deploy');
  assert.equal(probe.status, 503);
  assert.equal(JSON.parse(probe.body).trafficMode, 'draining');
  assert.equal(closed, 0);
  stopping.resolve();
  await closedStarted.promise;
  assert.equal((await request(port, 'platform', '/api/v1/platform/health/deploy')).status, 200);
  await runtime.stop();
});

test('signal shutdown racing with pending closed-listener startup waits for and closes the new listener', async () => {
  const fixture = trafficFixture();
  const closedStartup = deferred();
  const scheduled = scheduler();
  const events = [];
  const runtime = await startDemoEntrypointRuntime({ ...fixture,
    async startActive() { return { async stop() { events.push('active-stop'); } }; },
    onExpiryFailure() { assert.fail('Stop should succeed'); },
  }, { ...scheduled, clock: () => NOW, startClosed() { events.push('closed-starting'); return closedStartup.promise; } });
  scheduled.timers[0].callback();
  await tick();
  assert.deepEqual(events, ['active-stop', 'closed-starting']);
  const stop = runtime.stop();
  assert.equal(runtime.stop(), stop);
  closedStartup.resolve({ async stop() { events.push('closed-stop'); } });
  await stop;
  assert.deepEqual(events, ['active-stop', 'closed-starting', 'closed-stop']);
});

test('stop failure and hung stop both terminate without claiming quiescence or starting a closed listener', async () => {
  for (const failure of ['rejection', 'hang']) {
    const scheduled = scheduler();
    const events = [];
    let trafficGate;
    const runtime = await startDemoEntrypointRuntime({ ...trafficFixture(),
      async startActive(gate) {
        trafficGate = gate;
        return { stop() { return failure === 'hang' ? new Promise(() => {}) : Promise.reject(new Error('private detail')); } };
      }, onExpiryFailure(error) { events.push(error.message); },
    }, { ...scheduled, clock: () => NOW, startClosed() { assert.fail('Failed stop must not become ready'); } });
    scheduled.timers[0].callback();
    if (failure === 'hang') {
      assert.equal(scheduled.timers[1].delay, 10_000);
      scheduled.timers[1].callback();
    }
    await tick();
    assert.deepEqual(events, ['DEMO_TRAFFIC_SHUTDOWN_FAILED']);
    assert.equal(trafficGate.state(), 'draining');
    await assert.rejects(runtime.stop());
  }
});

test('Demo Platform composition propagates auxiliary pool shutdown failure', async () => {
  const fixture = trafficFixture('platform', 'closed');
  const events = [];
  // Construction creates a lazy ordinary persistence pool but never starts it or connects.
  const composition = createDemoPlatformComposition({ config: fixture.config,
    gatePool: { async connect() { assert.fail('No DB connection'); }, async end() { events.push('gate'); throw new Error('private'); } },
    resetPool: { async connect() { assert.fail('No DB connection'); }, async end() { events.push('reset'); } },
  });
  await assert.rejects(composition.stop(), /DEMO_PLATFORM_POOL_SHUTDOWN_FAILED/);
  assert.deepEqual(events.sort(), ['gate', 'reset']);
});

test('signal stop timeout terminates even after cancelling the acceptance deadline', async () => {
  const scheduled = scheduler();
  const events = [];
  const runtime = await startDemoEntrypointRuntime({ ...trafficFixture(),
    async startActive() { return { stop() { return new Promise(() => {}); } }; },
    onExpiryFailure(error) { events.push(error.message); },
  }, { ...scheduled, clock: () => NOW, startClosed() { assert.fail('Signal must not reopen a listener'); } });
  const stopping = runtime.stop();
  assert.equal(scheduled.timers[0].cancelled, true);
  assert.equal(scheduled.timers[1].delay, 10_000);
  scheduled.timers[1].callback();
  await assert.rejects(stopping, /DEMO_TRAFFIC_SHUTDOWN_FAILED/);
  assert.deepEqual(events, ['DEMO_TRAFFIC_SHUTDOWN_FAILED']);
});
