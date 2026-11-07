import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { publishJiraRegister } from './jira-register-publisher.mjs';

const failure = () => new Error('JIRA_REGISTER_RUN_UNVERIFIED');
const results = new Set(['JIRA_REGISTER_CONFIRMED', 'JIRA_REGISTER_TASK_PENDING',
  'JIRA_REGISTER_UNCHANGED', 'JIRA_REGISTER_ISSUE_NOT_IN_REVIEW']);

export function loadJiraWriterConfig(env = {}) {
  try {
    if (env.GITHUB_REPOSITORY !== 'floriankreutzer/conference-manager-api'
      || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.CM_JIRA_REGISTER_WRITER_ENABLED !== 'true') throw failure();
    const raw = env.CM_JIRA_REGISTER_DATABASE_URL;
    const host = env.CM_JIRA_REGISTER_DATABASE_HOST;
    if (typeof raw !== 'string' || raw.length > 4096 || /\s/.test(raw)
      || typeof host !== 'string' || !/^ep-[a-z0-9-]+\.[a-z0-9-]+\.aws\.neon\.tech$/.test(host)) throw failure();
    const url = new URL(raw);
    if (url.protocol !== 'postgresql:' || url.hostname !== host || (url.port && url.port !== '5432')
      || url.username !== 'cm_jira_register_writer' || !url.password || url.hash
      || url.pathname !== '/conference_manager_demo_shared'
      || url.searchParams.size !== 1 || url.searchParams.get('sslmode') !== 'verify-full') throw failure();
    // Do not let pg-connection-string options override the explicit TLS contract.
    url.search = '';
    return { database: { connectionString: url.toString(), ssl: { rejectUnauthorized: true },
      max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000,
      idleTimeoutMillis: 1000, application_name: 'cm-jira-register-writer' },
    publisher: { cloudId: env.CM_JIRA_CLOUD_ID, email: env.CM_JIRA_WRITER_EMAIL,
      token: env.CM_JIRA_WRITER_API_TOKEN, githubToken: env.CM_GITHUB_INVENTORY_TOKEN,
      issueKey: env.CM_JIRA_ISSUE_KEY } };
  } catch { throw failure(); }
}

export async function runJiraPublisher({ env = process.env, write = console.log,
  poolFactory = config => new Pool(config), publish = publishJiraRegister, fetchImpl = fetch } = {}) {
  let pool;
  let failed = false;
  let report = { result: 'JIRA_REGISTER_RUN_UNVERIFIED', readinessAuthorized: false };
  const controller = new AbortController();
  try {
    const config = loadJiraWriterConfig(env);
    pool = poolFactory(config.database);
    pool.on('error', () => { failed = true; controller.abort(); });
    const identity = await pool.query(`SELECT current_user AS role_name, current_database() AS database_name,
      r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS inherits_role
      FROM pg_roles r WHERE r.rolname=current_user`);
    const role = identity.rows[0];
    if (identity.rows.length !== 1 || role.role_name !== 'cm_jira_register_writer'
      || role.database_name !== 'conference_manager_demo_shared'
      || [role.rolsuper, role.rolcreatedb, role.rolcreaterole, role.rolbypassrls, role.inherits_role]
        .some(value => value !== false) || failed) throw failure();
    const result = await publish({ ...config.publisher, pool, fetchImpl: (url, options) => {
      if (failed || controller.signal.aborted) throw failure();
      return fetchImpl(url, { ...options, signal: AbortSignal.any([controller.signal, options.signal]) });
    } });
    if (!results.has(result?.result) || typeof result.writeSubmitted !== 'boolean'
      || result.readinessAuthorized !== false || failed) throw failure();
    report = { result: result.result, writeSubmitted: result.writeSubmitted, readinessAuthorized: false };
  } catch { failed = true; }
  finally {
    controller.abort();
    try { await pool?.end(); } catch { failed = true; }
  }
  if (failed) report = { result: 'JIRA_REGISTER_RUN_UNVERIFIED', readinessAuthorized: false };
  // No false no-write claim on failure, including cleanup after a submitted task.
  try { write(JSON.stringify(report)); } catch { return 1; }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = process.argv.length === 2 ? await runJiraPublisher() : 1;
}
