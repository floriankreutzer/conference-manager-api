import { isInternalUuid } from '../../src/domain/identifiers.js';
import { withPostgresTransaction } from '../../src/persistence/postgres/transaction.js';
import { loadMigrations } from '../db-migrations.mjs';
import { protectedRuntimeRoleManifest } from './protected-runtime-role-manifest.mjs';

const failed=()=>{ throw new Error('PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED'); };
function identifier(value) {
  if (typeof value!=='string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) failed();
  return `"${value}"`;
}
function scope(input) {
  if (!input || Reflect.ownKeys(input).length!==2 || Object.keys(input).sort().join(',')!=='environment,securityEpoch'
    || Object.values(Object.getOwnPropertyDescriptors(input)).some(field=>!Object.hasOwn(field,'value'))
    || !['dev','int','prod'].includes(input.environment) || !isInternalUuid(input.securityEpoch)) failed();
  return Object.freeze({ environment: input.environment,securityEpoch: input.securityEpoch.toLowerCase() });
}

// Pure, redacted review plan. No implicit environment, connection or mutation.
export function protectedRuntimeRoleGrantPlan(input) {
  const fixed=scope(input);
  return Object.freeze({ ...fixed,schemaVersion: 64,roles: Object.freeze(['customer','platform'].map(surface=>{
    const role=`cm_protected_${fixed.environment}_${surface}`,manifest=protectedRuntimeRoleManifest(surface);
    const statements=[`GRANT USAGE ON SCHEMA public TO ${identifier(role)}`,
      ...manifest.tables.map(entry=>`GRANT ${entry.privileges} ON public.${identifier(entry.name)} TO ${identifier(role)}`),
      ...manifest.functions.map(signature=>`GRANT EXECUTE ON FUNCTION public.${signature} TO ${identifier(role)}`),
      ...manifest.sequences.map(name=>`GRANT USAGE ON SEQUENCE public.${identifier(name)} TO ${identifier(role)}`)];
    return Object.freeze({ surface,role,statements: Object.freeze(statements) });
  })) });
}

// Explicit operator-only application to two fresh, externally created LOGIN
// roles. Does not create credentials, migrate, classify Tenants or activate roots.
export async function grantProtectedRuntimeRoles(pool,input) {
  try {
    const plan=protectedRuntimeRoleGrantPlan(input),roles=plan.roles.map(row=>row.role);
    if (typeof pool?.connect!=='function' || typeof pool?.query!=='function') failed();
    const migrations=await loadMigrations();
    if (migrations.length!==plan.schemaVersion || migrations.some((row,index)=>row.version!==index+1)) failed();
    await withPostgresTransaction(pool,async client=>{
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL lock_timeout='2s'");
      const lock=await client.query('SELECT pg_try_advisory_xact_lock(740193,$1::integer) AS locked',
        [{ dev: 1,int: 2,prod: 3 }[plan.environment]]);
      if (lock.rows[0]?.locked!==true) failed();
      const ledger=await client.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
      if (ledger.rowCount!==migrations.length || ledger.rows.some((row,index)=>row.version!==migrations[index].version
        || row.name!==migrations[index].name || row.checksum!==migrations[index].checksum)) failed();
      const deployment=await client.query(`SELECT security_epoch FROM protected_runtime_deployments
        WHERE environment=$1 AND security_epoch=$2 FOR UPDATE`,[plan.environment,plan.securityEpoch]);
      if (deployment.rowCount!==1) failed();
      const active=await client.query(`SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity
        WHERE usename=ANY($1::text[])`,[roles]);
      if (active.rows[0]?.count!==0) failed();
      const posture=await client.query(`SELECT role.rolname,role.rolcanlogin,
        (role.rolsuper OR role.rolcreatedb OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members member WHERE member.member=role.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_database owned WHERE owned.datdba=role.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace owned WHERE owned.nspowner=role.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_class owned WHERE owned.relowner=role.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc owned WHERE owned.proowner=role.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl owned WHERE owned.defaclrole=role.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc routine
            CROSS JOIN LATERAL pg_catalog.aclexplode(routine.proacl) privilege
            WHERE privilege.grantee=role.oid AND privilege.privilege_type='EXECUTE')
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace namespace
            WHERE pg_catalog.has_schema_privilege(role.oid,namespace.oid,'CREATE'))
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid=relation.relnamespace WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','f')
            AND (pg_catalog.has_table_privilege(role.oid,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              OR pg_catalog.has_any_column_privilege(role.oid,relation.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid=relation.relnamespace WHERE namespace.nspname='public' AND relation.relkind='S'
            AND CASE WHEN relation.relkind='S'
              THEN pg_catalog.has_sequence_privilege(role.oid,relation.oid,'USAGE,SELECT,UPDATE') ELSE false END))
          AS forbidden FROM pg_catalog.pg_roles role WHERE role.rolname=ANY($1::text[])`,[roles]);
      if (posture.rowCount!==2 || new Set(posture.rows.map(row=>row.rolname)).size!==2
        || posture.rows.some(row=>!roles.includes(row.rolname) || row.rolcanlogin!==true || row.forbidden!==false)) failed();
      const database=(await client.query('SELECT current_database() AS name')).rows[0]?.name;
      if (typeof database!=='string' || !database.length || database.length>63 || database.includes('\0')) failed();
      const quoted=`"${database.replaceAll('"','""')}"`;
      // Preserve existing CONNECT/USAGE and closed Demo grants. Only unsafe
      // PUBLIC create/temp defaults are removed, within the same transaction.
      await client.query(`REVOKE CREATE,TEMPORARY ON DATABASE ${quoted} FROM PUBLIC`);
      await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      const elevated=await client.query(`SELECT pg_catalog.has_database_privilege(rolname,current_database(),
        'CREATE,TEMPORARY') AS forbidden FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])`,[roles]);
      if (elevated.rowCount!==2 || elevated.rows.some(row=>row.forbidden!==false)) failed();
      for (const target of plan.roles) {
        await client.query(`GRANT CONNECT ON DATABASE ${quoted} TO ${identifier(target.role)}`);
        for (const statement of target.statements) await client.query(statement);
      }
    });
    return Object.freeze({ environment: plan.environment,securityEpoch: plan.securityEpoch,
      schemaVersion: plan.schemaVersion,roles: Object.freeze(roles) });
  } catch { failed(); }
}
