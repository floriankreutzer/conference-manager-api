import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { loadDemoConfig } from '../src/demo/config.js';
import { loadNeonRecoveryConfig } from './support/neon-recovery-config.mjs';
import { registerGitHubActionsSecretMasks, sensitiveGitHubActionsEnvironmentValues,
  serializeGitHubActionsEnvironment } from './github-actions-command-files.mjs';

try {
  if (process.argv.length !== 2 || !process.env.GITHUB_ENV) throw new Error('NEON_RECOVERY_ENV_INVALID');
  const variables = {
    NODE_ENV: 'test', DEMO_RUNTIME: 'shared-postgres-v1', DEMO_SEED_VERSION: 'saas-3.7-three-demo-customers-v1',
    DEMO_CUSTOMER_ORIGIN: 'https://customer.demo.test:4443', DEMO_PLATFORM_ORIGIN: 'https://platform.demo.test:4443',
    DEMO_DATABASE_SSL: 'verify-full',
  };
  for (const key of ['DEMO_CUSTOMER_SESSION_SECRET', 'DEMO_CUSTOMER_CSRF_SECRET',
    'DEMO_PLATFORM_SESSION_SECRET', 'DEMO_PLATFORM_CSRF_SECRET', 'DEMO_TENANT_AUDIT_HMAC_SECRET']) {
    variables[key] = randomBytes(32).toString('base64url');
  }
  const env = { ...process.env, ...variables };
  loadNeonRecoveryConfig(env);
  loadDemoConfig(env);
  registerGitHubActionsSecretMasks(sensitiveGitHubActionsEnvironmentValues(variables));
  await appendFile(process.env.GITHUB_ENV, serializeGitHubActionsEnvironment(variables), { mode: 0o600 });
  process.stdout.write('Isolated recovery runtime environment prepared.\n');
} catch {
  process.stderr.write('NEON_RECOVERY_PREPARATION_FAILED\n');
  process.exitCode = 1;
}
