import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresProtectedRuntimeReadiness } from '../src/persistence/postgres/protected-runtime-readiness.js';
import { protectedRuntimeRoleRequirements } from '../src/persistence/postgres/protected-runtime-role-requirements.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

// SET ROLE is confined to this isolated native fixture, never a production pool
// option. Actual SQL privilege/role metadata is evaluated; no permission result
// is mocked. Discard every connection so the role cannot leak into another user.
function asRole(base,role) {
  if (!['cm_protected_int_customer','cm_protected_int_platform'].includes(role)) throw new Error('FIXTURE_ROLE_INVALID');
  async function connect() {
    const client=await base.connect();
    try { await client.query(`SET ROLE "${role}"`); }
    catch (error) { client.release(true);throw error; }
    return { query: (...args)=>client.query(...args),release: ()=>client.release(true) };
  }
  return { connect,async query(input) { const client=await connect();try { return await client.query(input); }
    finally { client.release(); } } };
}
function identifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('FIXTURE_IDENTIFIER_INVALID');return `"${value}"`;
}

test('native protected readiness rejects real table/column escalation and role power while retaining current UUID and max1 leases',
async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const target=new URL(database.databaseUrl);
  if (!['127.0.0.1','localhost'].includes(target.hostname)
    || !/^\/conference_manager_test_\d+_\d+$/.test(target.pathname)) throw new Error('ISOLATED_ROLE_FIXTURE_DATABASE_REQUIRED');
  const admin=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const business=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const lease=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 }),created=[];
  t.after(async()=>{
    await Promise.all([business.end(),lease.end()]);
    try { for (const role of created.reverse()) { await admin.query(`DROP OWNED BY ${identifier(role)}`);
      await admin.query(`DROP ROLE ${identifier(role)}`); } }
    finally { await admin.end(); }
  });await migrateUp(admin);
  const epoch=randomUUID();
  await admin.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  await admin.query(`REVOKE ALL ON DATABASE ${identifier(target.pathname.slice(1))} FROM PUBLIC`);
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  const readers={};
  for (const surface of ['customer','platform']) {
    const role=`cm_protected_int_${surface}`,policy=protectedRuntimeRoleRequirements(surface);
    // A pre-existing cluster role makes CREATE fail; it is never adopted, altered
    // or dropped by this isolated fixture. No password/login is used by SET ROLE.
    await admin.query(`CREATE ROLE ${identifier(role)} LOGIN`);created.push(role);
    await admin.query(`GRANT CONNECT ON DATABASE ${identifier(target.pathname.slice(1))} TO ${identifier(role)}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${identifier(role)}`);
    for (const table of policy.read) await admin.query(`GRANT SELECT ON public.${identifier(table)} TO ${identifier(role)}`);
    for (const table of policy.write) {
      await admin.query(`GRANT INSERT,UPDATE,DELETE ON public.${identifier(table)} TO ${identifier(role)}`);
    }
    for (const spec of policy.readColumns) {
      const [table,column]=spec.split('.');
      await admin.query(`GRANT SELECT(${identifier(column)}) ON public.${identifier(table)} TO ${identifier(role)}`);
    }
    readers[surface]=createPostgresProtectedRuntimeReadiness(asRole(business,role),{
      leasePool: asRole(lease,role),environment: 'int',securityEpoch: epoch,surface });
    assert.equal(await readers[surface].isReady(),true,surface);
  }
  const role='cm_protected_int_customer';
  await admin.query(`REVOKE SELECT(authenticated_at) ON platform_microsoft_operation_proofs FROM ${identifier(role)}`);
  assert.equal(await readers.customer.isReady(),false);
  await admin.query(`GRANT SELECT(authenticated_at) ON platform_microsoft_operation_proofs TO ${identifier(role)}`);
  assert.equal(await readers.customer.isReady(),true);
  await admin.query(`GRANT SELECT(state_hash) ON platform_microsoft_operation_proofs TO ${identifier(role)}`);
  assert.equal(await readers.customer.isReady(),false);
  await admin.query(`REVOKE SELECT(state_hash) ON platform_microsoft_operation_proofs FROM ${identifier(role)}`);
  assert.equal(await readers.customer.isReady(),true);
  await admin.query(`GRANT SELECT ON platform_microsoft_operation_proofs TO ${identifier(role)}`);
  assert.equal(await readers.customer.isReady(),false);
  await admin.query(`REVOKE SELECT ON platform_microsoft_operation_proofs FROM ${identifier(role)}`);
  // PostgreSQL also revokes column SELECT when table SELECT is revoked. Prove
  // the missing custody predicate still fails closed, then restore only the
  // explicitly approved columns rather than retaining the escalated grant.
  assert.equal(await readers.customer.isReady(),false);
  for (const spec of protectedRuntimeRoleRequirements('customer').readColumns) {
    const [table,column]=spec.split('.');
    if (table==='platform_microsoft_operation_proofs') {
      await admin.query(`GRANT SELECT(${identifier(column)}) ON public.${identifier(table)} TO ${identifier(role)}`);
    }
  }
  assert.equal(await readers.customer.isReady(),true);

  await admin.query(`GRANT INSERT ON platform_operators TO ${identifier(role)}`);
  assert.equal(await readers.customer.isReady(),false);
  await admin.query(`REVOKE INSERT ON platform_operators FROM ${identifier(role)}`);
  assert.equal(await readers.customer.isReady(),true);
  await admin.query(`GRANT UPDATE(status) ON platform_operators TO ${identifier(role)}`);
  const column=(await admin.query(`SELECT has_table_privilege($1,'platform_operators','UPDATE') AS table_right,
    has_any_column_privilege($1,'platform_operators','UPDATE') AS column_right`,[role])).rows[0];
  assert.deepEqual(column,{ table_right: false,column_right: true });
  assert.equal(await readers.customer.isReady(),false);
  await admin.query(`REVOKE UPDATE(status) ON platform_operators FROM ${identifier(role)}`);
  await admin.query(`REVOKE INSERT ON sessions FROM ${identifier(role)}`);
  assert.equal(await readers.customer.isReady(),false);
  await admin.query(`GRANT INSERT ON sessions TO ${identifier(role)}`);
  await admin.query(`ALTER ROLE ${identifier(role)} CREATEROLE`);assert.equal(await readers.customer.isReady(),false);
  await admin.query(`ALTER ROLE ${identifier(role)} NOCREATEROLE`);
  await admin.query(`GRANT CREATE ON SCHEMA public TO ${identifier(role)}`);assert.equal(await readers.customer.isReady(),false);
  await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${identifier(role)}`);
  assert.equal(await readers.customer.isReady(),true);
  const platform='cm_protected_int_platform';
  await admin.query(`GRANT INSERT ON platform_passkey_enrollment_grants TO ${identifier(platform)}`);
  assert.equal(await readers.platform.isReady(),false);
  await admin.query(`REVOKE INSERT ON platform_passkey_enrollment_grants FROM ${identifier(platform)}`);
  assert.equal(await readers.platform.isReady(),true);
  await admin.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,revision=revision+1,
    updated_at=clock_timestamp() WHERE environment='int'`,[randomUUID()]);
  assert.equal(await readers.customer.isReady(),false);assert.equal(await readers.platform.isReady(),false);
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM platform_operators')).rows[0].count,0);
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM platform_passkey_enrollment_grants')).rows[0].count,0);
});
