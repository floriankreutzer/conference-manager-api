import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

// A separate named actual-time acceptance, never a timeout increase or skip in
// the existing ordinary120s-per-file runner. Only the fixed local CI fixture may
// be targeted; no managed database, provider, live secret or paid resource.
let client,created=false,name,failed=false;
try {
  const url=new URL(process.env.DATABASE_URL);
  if (process.argv.length!==2 || process.env.NODE_ENV!=='test' || process.env.DATABASE_SSL!=='disable'
    || !['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost'].includes(url.hostname)
    || url.username!=='conference_manager' || url.pathname!=='/conference_manager') {
    throw new Error('HANDOFF_EXPIRY_LOCAL_FIXTURE_REQUIRED');
  }
  name=`cm_handoff_expiry_${process.pid}_${randomBytes(8).toString('hex')}`;
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error('HANDOFF_EXPIRY_DATABASE_NAME_INVALID');
  const admin=new URL(url);admin.pathname='/postgres';
  client=new Client({ connectionString: admin.toString(),ssl: false,connectionTimeoutMillis: 5000,
    statement_timeout: 10_000,query_timeout: 15_000 });
  await client.connect();await client.query(`CREATE DATABASE "${name}"`);created=true;
  const isolated=new URL(url);isolated.pathname=`/${name}`;
  const result=spawnSync(process.execPath,['--test','--test-concurrency=1','tests-db/acceptance/synthetic-handoff-proof-expiry.test.js'],
    { env: { ...process.env,DATABASE_URL: isolated.toString() },stdio: 'inherit',timeout: 180_000 });
  if (result.error || result.signal || result.status!==0) failed=true;
} catch {
  failed=true;process.stderr.write('HANDOFF_EXPIRY_ACCEPTANCE_FAILED\n');
} finally {
  if (created) {
    try { await client.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    catch { failed=true;process.stderr.write('HANDOFF_EXPIRY_CLEANUP_FAILED\n'); }
  }
  try { await client?.end(); } catch { failed=true; }
}
if (failed) process.exitCode=1;
