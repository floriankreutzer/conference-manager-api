import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

import pg from 'pg';

import {
  registerGitHubActionsSecretMasks,
  sensitiveGitHubActionsEnvironmentValues,
  serializeGitHubActionsEnvironment,
} from './github-actions-command-files.mjs';

const { Client } = pg;
const DATABASE = 'conference_manager_demo_ci';
const ROLES = Object.freeze({
  customer: 'cm_demo_customer_ci',
  platform: 'cm_demo_platform_ci',
  reset: 'cm_demo_reset_ci',
  migration: 'cm_demo_migration_ci',
});
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5432/postgres';
const ENVIRONMENT_FILE = process.env.GITHUB_ENV;

if (!ENVIRONMENT_FILE) throw new Error('GITHUB_ENV_REQUIRED');

function credential() {
  return randomBytes(32).toString('base64url');
}

function databaseUrl(role, password) {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}`
    + `@127.0.0.1:5432/${DATABASE}`;
}

async function createRole(client, role, password) {
  const statement = await client.query({
    text: "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS sql",
    values: [role, password],
  });
  await client.query(statement.rows[0].sql);
}

const passwords = Object.freeze(Object.fromEntries(
  Object.keys(ROLES).map((key) => [key, credential()]),
));
const secrets = Object.freeze({
  DEMO_CUSTOMER_SESSION_SECRET: credential(),
  DEMO_CUSTOMER_CSRF_SECRET: credential(),
  DEMO_PLATFORM_SESSION_SECRET: credential(),
  DEMO_PLATFORM_CSRF_SECRET: credential(),
  DEMO_TENANT_AUDIT_HMAC_SECRET: credential(),
});
const variables = {
  NODE_ENV: 'test',
  DEMO_RUNTIME: 'shared-postgres-v1',
  DEMO_SEED_VERSION: 'saas-3.5-shared-demo-v1',
  DEMO_CUSTOMER_ORIGIN: 'https://customer.demo.test:4443',
  DEMO_PLATFORM_ORIGIN: 'https://platform.demo.test:4443',
  DEMO_DATABASE_SSL: 'disable',
  DEMO_CUSTOMER_DATABASE_URL: databaseUrl(ROLES.customer, passwords.customer),
  DEMO_PLATFORM_DATABASE_URL: databaseUrl(ROLES.platform, passwords.platform),
  DEMO_RESET_DATABASE_URL: databaseUrl(ROLES.reset, passwords.reset),
  DEMO_MIGRATION_DATABASE_URL: databaseUrl(ROLES.migration, passwords.migration),
  ...secrets,
};
registerGitHubActionsSecretMasks([
  ...sensitiveGitHubActionsEnvironmentValues(variables),
  ...Object.values(passwords),
]);
const client = new Client({ connectionString: ADMIN_URL });

try {
  await client.connect();
  const existingDatabase = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
  if (existingDatabase.rowCount !== 0) throw new Error('SHARED_DEMO_CI_DATABASE_ALREADY_EXISTS');
  for (const [key, role] of Object.entries(ROLES)) {
    await createRole(client, role, passwords[key]);
  }
  await client.query(`CREATE DATABASE ${DATABASE} OWNER ${ROLES.migration}`);
  await client.query(
    `GRANT CONNECT ON DATABASE ${DATABASE} TO ${ROLES.customer}, ${ROLES.platform}, ${ROLES.reset}`,
  );
} finally {
  await client.end();
}

await appendFile(
  ENVIRONMENT_FILE,
  serializeGitHubActionsEnvironment(variables),
  { encoding: 'utf8', mode: 0o600 },
);
process.stdout.write('Shared Demo CI database principals and runtime environment provisioned.\n');
