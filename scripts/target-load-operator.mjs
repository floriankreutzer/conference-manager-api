import { pathToFileURL } from 'node:url';
import { prepareTargetLoadSetup } from './target-load-setup.mjs';
import { runTargetLoadController } from './target-load-controller.mjs';
import { loadTargetSetupConfig } from './support/target-load-setup-config.mjs';
import { loadTargetOperatorConfig } from './support/target-load-operator-config.mjs';
import { validateTargetLoadManifest } from './support/target-load-manifest.mjs';
import { awaitTargetOperatorRelease } from './support/target-load-operator-gate.mjs';
import { createTargetOperatorServer } from './support/target-load-operator-http.mjs';

export async function startTargetLoadOperator({ env = process.env, clock = Date.now,
  exit = code => process.exit(code), setup = prepareTargetLoadSetup, gate = awaitTargetOperatorRelease,
  controller = runTargetLoadController, serverFactory = createTargetOperatorServer } = {}) {
  const settings = loadTargetOperatorConfig(env, clock());
  const { values, population } = loadTargetSetupConfig(env, clock());
  if (population !== 100 || settings.scope.expiresMs - clock() < 55 * 60_000) throw new Error('LOAD_OPERATOR_FAILED');
  let phase = 'preparing'; let evidence; let stopped = false; let finished = false; let listening = false;
  const timer = setTimeout(() => exit(1), Math.max(0, settings.scope.expiresMs - clock())); timer.unref();
  const server = serverFactory({ settings, clock, status: () => evidence ? { phase, evidence } : { phase } });
  async function stop() {
    if (stopped) return; stopped = true;
    // Keep the independent deadline armed until every socket has closed.
    try { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    finally {
      if (finished) clearTimeout(timer);
      else if (listening) exit(1);
    }
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(settings.port, '0.0.0.0', resolve); });
    listening = true;
  } catch { await stop(); throw new Error('LOAD_OPERATOR_FAILED'); }
  const done = (async () => {
    try {
      const manifest = validateTargetLoadManifest(await setup({ env, clock, exit }), values, clock());
      if (stopped) throw new Error();
      await gate({ env, clock, prepared: () => { phase = 'waiting'; } });
      if (stopped) throw new Error();
      phase = 'measuring';
      const result = await controller({ env, clock, exit,
        readManifest: async () => validateTargetLoadManifest(manifest, values, clock()) });
      if (stopped) throw new Error();
      evidence = result;
      phase = 'measured';
    } catch { phase = 'failed'; evidence = undefined; }
    finally { finished = true; if (stopped) clearTimeout(timer); }
    // Remain observable until explicit suspension/expiry. Never reseed or resume
    // from an ephemeral disk after a Render restart: setup's marker forbids it.
  })();
  return Object.freeze({ server, done, stop });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const runtime = await startTargetLoadOperator();
    process.once('SIGTERM', () => { runtime.stop().finally(() => process.exit(1)); });
    process.once('SIGINT', () => { runtime.stop().finally(() => process.exit(1)); });
  } catch { process.stderr.write('LOAD_OPERATOR_FAILED\n'); process.exitCode = 1; }
}
