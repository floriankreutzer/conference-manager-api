import { loadDemoMediaStorageConfig } from './media-storage-config.js';
import { loadDemoTrafficGateConfig } from './traffic-gate-config.js';
import { createDemoTrafficGate } from './traffic-gate.js';
import { startDemoClosedRuntime } from './closed-runtime.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

export async function startDemoEntrypointRuntime({ env, config, surface, boundary, startActive, onExpiryFailure } = {}, {
  clock = () => Date.now(), startClosed = startDemoClosedRuntime,
  schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  if ([startActive, onExpiryFailure, clock, startClosed, schedule, cancel].some((value) => typeof value !== 'function')) {
    throw new TypeError('DEMO_ENTRYPOINT_RUNTIME_INVALID');
  }
  // Preserve pure credential/role/origin/TLS/storage-pin checks even when closed.
  loadDemoMediaStorageConfig(env, { config, surface });
  const settings = loadDemoTrafficGateConfig(env, { config, surface, now: clock() });
  const trafficGate = createDemoTrafficGate({ settings, config, surface, boundary, clock });
  if (['closed', 'expired'].includes(trafficGate.state())) {
    return startClosed({ config, surface, trafficGate });
  }
  let runtime;
  let timer;
  let stopping = false;
  let failed = false;
  let transition;
  let stopPromise;
  function fail() {
    trafficGate.close();
    if (!failed) {
      failed = true;
      // Entrypoints terminate the process: unfinished bootstrap/jobs cannot survive.
      onExpiryFailure(new Error('DEMO_TRAFFIC_SHUTDOWN_FAILED'));
    }
  }
  async function boundedStop(target) {
    let watchdog;
    try {
      await Promise.race([
        target.stop(),
        new Promise((resolve, reject) => {
          watchdog = schedule(() => reject(new Error('DEMO_TRAFFIC_SHUTDOWN_FAILED')), SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } finally { cancel(watchdog); }
  }
  function expire() {
    trafficGate.close();
    if (transition || stopping || failed) return;
    if (!runtime) {
      // Startup owns resources before it can return a stoppable runtime. Fail the
      // process at the absolute deadline instead of permitting late worker startup.
      fail();
      return;
    }
    transition = (async () => {
      await boundedStop(runtime);
      trafficGate.markQuiescent();
      // Only a fully stopped runtime permits a green closed deployment listener.
      if (!stopping) runtime = await startClosed({ config, surface, trafficGate });
    })();
    transition.catch(fail);
  }
  // Arm before startup, including the actual DB/media/sentinel checks and workers.
  trafficGate.markActive();
  if (settings.mode === 'acceptance') {
    const delay = settings.expiresAt - clock();
    if (delay <= 0) expire();
    else {
      timer = schedule(expire, delay);
      timer?.unref?.();
    }
  }
  if (failed) throw new Error('DEMO_TRAFFIC_SHUTDOWN_FAILED');
  try {
    runtime = await startActive(trafficGate);
    if (failed) {
      // Defensive for injected termination handlers; production already exited.
      await boundedStop(runtime);
      throw new Error('DEMO_TRAFFIC_SHUTDOWN_FAILED');
    }
    if (settings.mode === 'acceptance' && clock() >= settings.expiresAt) {
      expire();
      await transition;
    }
  } catch {
    cancel(timer);
    throw new Error('DEMO_TRAFFIC_START_FAILED');
  }
  return Object.freeze({
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      cancel(timer);
      trafficGate.close();
      stopPromise = (async () => {
        try {
          if (transition) await transition;
          await boundedStop(runtime);
        } catch {
          fail();
          throw new Error('DEMO_TRAFFIC_SHUTDOWN_FAILED');
        }
      })();
      return stopPromise;
    },
  });
}
