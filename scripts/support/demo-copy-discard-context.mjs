const DECISION = 'saas38-pre-pilot-demo-only';
const DEBUG_KEYS = ['NODE_OPTIONS', 'NODE_DEBUG', 'DEBUG', 'SSLKEYLOGFILE', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'RUNNER_DEBUG', 'ACTIONS_STEP_DEBUG', 'ACTIONS_RUNNER_DEBUG'];

export function loadDemoCopyDiscardContext(env, now = Date.now()) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_REPOSITORY !== 'floriankreutzer/conference-manager-api'
    || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_ACTOR !== 'floriankreutzer'
    || env.GITHUB_TRIGGERING_ACTOR !== 'floriankreutzer' || env.GITHUB_RUN_ATTEMPT !== '1'
    || !/^[a-f0-9]{40}$/.test(env.DEMO_COPY_SOURCE_SHA || '') || env.DEMO_COPY_SOURCE_SHA !== env.GITHUB_SHA
    || !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID || '')
    || DEBUG_KEYS.some((key) => env[key] !== undefined)) throw new Error('DEMO_COPY_EXECUTION_CONTEXT_INVALID');
  const action = env.DEMO_COPY_ACTION;
  const kind = env.DEMO_COPY_KIND;
  const expiry = env.DEMO_COPY_EXPIRES_AT;
  const expiresAt = Date.parse(expiry);
  if (!['preflight', 'discard'].includes(action)
    || (action === 'preflight' ? kind !== 'none' : !['room', 'catalogue'].includes(kind))
    || !Number.isSafeInteger(now) || typeof expiry !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiry)
    || !Number.isSafeInteger(expiresAt) || new Date(expiresAt).toISOString() !== expiry
    || expiresAt - now > 30 * 60_000 || expiresAt - now < 3 * 60_000
    || (action === 'discard' ? env.DEMO_COPY_DECISION !== DECISION
      || !/^[a-f0-9]{64}$/.test(env.DEMO_COPY_MANIFEST_SHA256 || '')
      : (env.DEMO_COPY_DECISION || '') !== '' || (env.DEMO_COPY_MANIFEST_SHA256 || '') !== '')) {
    throw new Error('DEMO_COPY_OPERATION_INVALID');
  }
  return Object.freeze({ action, kind, expiresAt, sourceSha: env.GITHUB_SHA,
    expectedManifestSha256: action === 'discard' ? env.DEMO_COPY_MANIFEST_SHA256 : null, runId: env.GITHUB_RUN_ID });
}
