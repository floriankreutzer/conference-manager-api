export const RUN = 'abcde01234567890'; export const SHA = 'a'.repeat(40); export const NOW = 1_800_000_000_000;
export function targetLoadEnvironment(surface = 'customer', runId = RUN) {
  const value = { LOAD_RUN_ID: runId, LOAD_RELEASE_SHA: SHA, LOAD_SURFACE: surface,
    LOAD_CREATED_AT: new Date(NOW - 1000).toISOString(), LOAD_EXPIRES_AT: new Date(NOW + 60_000).toISOString(),
    LOAD_DATABASE_HOST: 'ep-synthetic.c-5.eu-central-1.aws.neon.tech', LOAD_OBSERVER_TOKEN: 'b'.repeat(43),
    LOAD_STORAGE_BUCKET: `saas38-load-${runId}`, LOAD_SERVICE_NAME: `cm-saas38-load-${runId}-${surface}`,
    LOAD_PUBLIC_ORIGIN: `https://cm-saas38-load-${runId}-${surface}.onrender.com`,
    LOAD_DATABASE_URL: `postgresql://saas38_load_${runId}_${surface}:synthetic-password@`
      + `ep-synthetic.c-5.eu-central-1.aws.neon.tech/saas38_load_${runId}?sslmode=verify-full`,
    LOAD_CSRF_SECRET: 'csrf-fixture-secret-at-least-thirty-two-bytes',
    LOAD_AUDIT_HMAC_SECRET: 'audit-fixture-secret-at-least-thirty-two-bytes',
    RENDER: 'true', RENDER_GIT_REPO_SLUG: 'floriankreutzer/conference-manager-api', RENDER_GIT_BRANCH: 'main',
    RENDER_GIT_COMMIT: SHA, RENDER_SERVICE_NAME: `cm-saas38-load-${runId}-${surface}` };
  if (surface === 'customer') Object.assign(value, { LOAD_STORAGE_BRANCH: 'br-synthetic-load-target',
    LOAD_STORAGE_PROBE_JSON: JSON.stringify({ tenantId: '11111111-1111-4111-8111-111111111111',
      assetId: '22222222-2222-4222-8222-222222222222', sha256: 'c'.repeat(64), byteLength: 100 }),
    LOAD_STORAGE_ACCESS_KEY_ID: 'synthetic-access-key', LOAD_STORAGE_SECRET_ACCESS_KEY: 'synthetic-storage-secret-material' });
  else Object.assign(value, { LOAD_CURSOR_SECRET: 'cursor-fixture-secret-at-least-thirty-two-bytes',
    LOAD_TENANT_AUDIT_HMAC_SECRET: 'tenant-audit-fixture-secret-at-least-thirty-two-bytes' });
  return value;
}


export function targetLoadSetupEnvironment(runId = RUN, now = NOW) {
  const env = targetLoadEnvironment('customer', runId);
  env.LOAD_SURFACE = 'setup'; env.LOAD_DATABASE_URL = env.LOAD_DATABASE_URL.replace('_customer:', '_setup:');
  env.LOAD_CREATED_AT = new Date(now - 1000).toISOString(); env.LOAD_EXPIRES_AT = new Date(now + 600_000).toISOString();
  for (const key of Object.keys(env)) if (key.startsWith('RENDER') || ['LOAD_SERVICE_NAME', 'LOAD_STORAGE_PROBE_JSON'].includes(key)) {
    delete env[key];
  }
  return env;
}
