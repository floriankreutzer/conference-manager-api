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
  return Object.freeze({ ...fixed,schemaVersion: 75,roles: Object.freeze(['customer','platform'].map(surface=>{
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

// Incremental transition for existing INT roles. Never reruns the fresh-role
// installer, grants segment administration, or accepts caller-supplied SQL.
export function platformAuditSegmentRoleGrantPlan(input) {
  if (!input || Reflect.ownKeys(input).length!==3
    || Object.keys(input).sort().join(',')!=='environment,securityEpoch,segmentId'
    || Object.values(Object.getOwnPropertyDescriptors(input)).some(field=>!Object.hasOwn(field,'value'))) failed();
  const fixed=scope({ environment: input.environment,securityEpoch: input.securityEpoch });
  if (fixed.environment!=='int' || !isInternalUuid(input.segmentId)) failed();
  const customer=identifier('cm_protected_int_customer'),platform=identifier('cm_protected_int_platform');
  return Object.freeze({ ...fixed,segmentId: input.segmentId,schemaVersion: 75,
    roles: Object.freeze(['cm_protected_int_customer','cm_protected_int_platform']),statements: Object.freeze([
      `GRANT SELECT(id,environment,deployment_epoch) ON public.platform_audit_segments TO ${customer}`,
      `GRANT SELECT(segment_id,integrity_version) ON public.platform_audit_events TO ${customer}`,
      `GRANT SELECT ON public.platform_audit_segments TO ${platform}`,
      `GRANT SELECT,UPDATE ON public.platform_audit_segment_heads TO ${platform}`,
      `GRANT SELECT,INSERT ON public.platform_audit_segment_checkpoints TO ${platform}`,
      `REVOKE UPDATE ON public.platform_audit_chain_state FROM ${platform}`,
      `REVOKE INSERT ON public.platform_audit_checkpoints FROM ${platform}`,
    ]) });
}

// Existing INT roles need only these two Customer authority tables after069.
// The fixed segment/deployment binding and both-role drain remain mandatory.
export function customerMicrosoftGroupRoleGrantPlan(input) {
  const base=platformAuditSegmentRoleGrantPlan(input),customer=identifier('cm_protected_int_customer');
  const entries=protectedRuntimeRoleManifest('customer').tables.filter(entry=>
    ['tenant_microsoft_role_settings','customer_microsoft_group_observations'].includes(entry.name));
  if (entries.length!==2) failed();
  return Object.freeze({ ...base,statements: Object.freeze(entries.map(entry=>
    `GRANT ${entry.privileges} ON public.${identifier(entry.name)} TO ${customer}`)) });
}

export async function grantPlatformAuditSegmentRuntimeRoles(pool,input,options={}) {
  try { return await grantIncrementalRuntimeRoles(pool,platformAuditSegmentRoleGrantPlan(input),options); }
  catch { failed(); }
}

export async function grantCustomerMicrosoftGroupRuntimeRoles(pool,input,options={}) {
  try { return await grantIncrementalRuntimeRoles(pool,customerMicrosoftGroupRoleGrantPlan(input),options); }
  catch { failed(); }
}

// Existing INT Customer needs only the mutable lifecycle columns on started request workflows.
export function customerRequestWorkflowRoleGrantPlan(input) {
  const base=platformAuditSegmentRoleGrantPlan(input),customer=identifier('cm_protected_int_customer');
  const entries=protectedRuntimeRoleManifest('customer').tables.filter(entry=>entry.name==='request_workflow_starts'
    && entry.privileges.startsWith('UPDATE('));
  if (entries.length!==1
    || entries[0].privileges!=='UPDATE(status,ended_at,request_id,submission_fingerprint)') failed();
  return Object.freeze({ ...base,statements: Object.freeze([
    `GRANT ${entries[0].privileges} ON public.${identifier(entries[0].name)} TO ${customer}`,
  ]) });
}

export async function grantCustomerRequestWorkflowRuntimeRoles(pool,input,options={}) {
  try { return await grantIncrementalRuntimeRoles(pool,customerRequestWorkflowRoleGrantPlan(input),options); }
  catch { failed(); }
}

// Existing roles receive only the private Platform proof table after070.
export function platformMicrosoftOperationRoleGrantPlan(input) {
  const base=platformAuditSegmentRoleGrantPlan(input),platform=identifier('cm_protected_int_platform');
  return Object.freeze({ ...base,statements: Object.freeze([
    `GRANT SELECT,INSERT,UPDATE,DELETE ON public.platform_microsoft_operation_proofs TO ${platform}`,
  ]) });
}

export async function grantPlatformMicrosoftOperationRuntimeRoles(pool,input,options={}) {
  try { return await grantIncrementalRuntimeRoles(pool,platformMicrosoftOperationRoleGrantPlan(input),options); }
  catch { failed(); }
}

// Existing INT Customer receives only current-custody predicate columns; no
// browser binding, nonce/state MAC, full-table read, mutation or function grant.
export function syntheticMicrosoftCustodyRoleGrantPlan(input) {
  const base=platformAuditSegmentRoleGrantPlan(input),customer=identifier('cm_protected_int_customer');
  const entries=protectedRuntimeRoleManifest('customer').tables.filter(entry=>entry.name==='platform_microsoft_operation_proofs');
  if (entries.length!==1 || !entries[0].privileges.startsWith('SELECT(')) failed();
  return Object.freeze({ ...base,statements: Object.freeze([
    `GRANT ${entries[0].privileges} ON public.platform_microsoft_operation_proofs TO ${customer}`,
    `GRANT SELECT(step_up_expires_at) ON public.platform_sessions TO ${customer}`,
  ]) });
}

export async function grantSyntheticMicrosoftCustodyRuntimeRoles(pool,input,options={}) {
  try { return await grantIncrementalRuntimeRoles(pool,syntheticMicrosoftCustodyRoleGrantPlan(input),options); }
  catch { failed(); }
}

// Separate fixed owner-custody delta for the two existing drained INT roles.
// Customer never receives Platform mutation or stable own-identity creation.
export function ownerCustomerCustodyRoleGrantPlan(input) {
  const base=platformAuditSegmentRoleGrantPlan(input),statements=[];
  const tables={ customer: ['owner_customer_handoffs','owner_handoff_start_budgets','platform_owner_customer_users'],
    platform: ['owner_customer_handoffs','platform_owner_customer_users'] };
  for (const surface of ['customer','platform']) {
    const role=identifier(`cm_protected_int_${surface}`),manifest=protectedRuntimeRoleManifest(surface);
    for (const name of tables[surface]) {
      const entry=manifest.tables.find(value=>value.name===name);if (!entry) failed();
      statements.push(`GRANT ${entry.privileges} ON public.${identifier(name)} TO ${role}`);
    }
    if (surface==='customer') {
      statements.push(`GRANT SELECT(target_type,target_id,retention_class,roles,permissions) ON public.platform_audit_events TO ${role}`);
      for (const name of ['protected_lock_owner_handoff_source','protected_lock_owner_customer_source']) {
        const signature=`${name}(text,uuid,uuid)`;if (!manifest.functions.includes(signature)) failed();
        statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${role}`);
      }
    }
  }
  return Object.freeze({ ...base,statements: Object.freeze(statements) });
}

export async function grantOwnerCustomerCustodyRuntimeRoles(pool,input,options={}) {
  try { return await grantIncrementalRuntimeRoles(pool,ownerCustomerCustodyRoleGrantPlan(input),options); }
  catch { failed(); }
}

async function grantIncrementalRuntimeRoles(pool,plan,{ expectedOfflineRole,auditRepository }={}) {
  try {
    identifier(expectedOfflineRole);
    if (typeof auditRepository?.verifyWithClient!=='function') failed();
    const migrations=await loadMigrations();
    if (migrations.length!==plan.schemaVersion) failed();
    await withPostgresTransaction(pool,async client=>{
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL lock_timeout='2s'");
      const lock=await client.query('SELECT pg_try_advisory_xact_lock(740193,2) AS locked');
      if (lock.rows[0]?.locked!==true) failed();
      const owner=await client.query(`SELECT current_user AS active_role,session_user AS authenticated_role,
        pg_get_userbyid(relowner) AS owner_role FROM pg_class WHERE oid='public.platform_operators'::regclass`);
      if (owner.rowCount!==1 || ['active_role','authenticated_role','owner_role']
        .some(key=>owner.rows[0][key]!==expectedOfflineRole)) failed();
      const ledger=await client.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
      if (ledger.rowCount!==migrations.length || ledger.rows.some((row,index)=>row.version!==migrations[index].version
        || row.name!==migrations[index].name || row.checksum!==migrations[index].checksum)) failed();
      const segment=await client.query(`SELECT s.id FROM platform_audit_segments s JOIN protected_runtime_deployments d
        ON d.environment=s.environment AND d.security_epoch=s.deployment_epoch
        WHERE s.id=$1 AND s.environment='int' AND s.deployment_epoch=$2 FOR SHARE OF s,d`,[plan.segmentId,plan.securityEpoch]);
      if (segment.rowCount!==1) failed();
      const active=await client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=ANY($1::text[])',[plan.roles]);
      if (active.rows[0]?.count!==0) failed();
      const roles=await client.query(`SELECT rolname,rolcanlogin,
        (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
          OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
          OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relowner=r.oid)
          OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.proowner=r.oid)
          OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid)
          OR EXISTS(SELECT 1 FROM pg_database d WHERE d.datdba=r.oid)
          OR EXISTS(SELECT 1 FROM pg_default_acl a WHERE a.defaclrole=r.oid)
          OR has_database_privilege(r.oid,current_database(),'CREATE,TEMPORARY')
          OR has_schema_privilege(r.oid,'public','CREATE')) AS forbidden
        FROM pg_roles r WHERE rolname=ANY($1::text[])`,[plan.roles]);
      if (roles.rowCount!==2 || roles.rows.some(row=>row.rolcanlogin!==true || row.forbidden!==false)) failed();
      await auditRepository.verifyWithClient(client);
      for (const statement of plan.statements) await client.query(statement);
    });
    return Object.freeze({ environment: 'int',segmentId: plan.segmentId,schemaVersion: plan.schemaVersion,
      roles: plan.roles,status: 'granted' });
  } catch { failed(); }
}

// Existing INT observability readers receive no write, Customer or administrative
// authority. The checked incremental port retains ledger, audit and drain gates.
export function platformObservabilityReadRoleGrantPlan(input) {
  const base=platformAuditSegmentRoleGrantPlan(input),platform=identifier('cm_protected_int_platform');
  const names=['platform_runtime_deployments','platform_runtime_tenant_mappings','platform_diagnostic_events',
    'platform_metering_periods','platform_operational_quotas'];
  const manifest=protectedRuntimeRoleManifest('platform');
  if (names.some(name=>!manifest.tables.some(entry=>entry.name===name && entry.privileges.split(',').includes('SELECT')))) failed();
  return Object.freeze({ ...base,statements: Object.freeze(names.map(name=>
    `GRANT SELECT ON public.${identifier(name)} TO ${platform}`)) });
}

export async function grantPlatformObservabilityReadRuntimeRoles(pool,input,options={}) {
  try { return await grantIncrementalRuntimeRoles(pool,platformObservabilityReadRoleGrantPlan(input),options); }
  catch { failed(); }
}

// Existing drained INT roles need only the same three positive grants prepared
// by the fresh manifest. No binding mutation goes to Customer, and the private
// lifecycle helper remains ungranted. Reuse the exact ledger/audit/drain gate.
export function syntheticParticipantRoleGrantPlan(input) {
  const base=platformAuditSegmentRoleGrantPlan(input),customer=identifier('cm_protected_int_customer');
  const signatures=['protected_lock_synthetic_participant_scope(text,uuid,uuid,uuid,uuid,boolean)',
    'protected_synthetic_participant_lifecycle(text,uuid,uuid,text,text,bigint)'];
  const customerManifest=protectedRuntimeRoleManifest('customer'),platformManifest=protectedRuntimeRoleManifest('platform');
  const binding=platformManifest.tables.find(entry=>entry.name==='synthetic_invited_memberships');
  if (signatures.some(signature=>!customerManifest.functions.includes(signature)) || binding?.privileges!=='SELECT,INSERT') failed();
  return Object.freeze({ ...base,statements: Object.freeze([
    ...signatures.map(signature=>`GRANT EXECUTE ON FUNCTION public.${signature} TO ${customer}`),
    `GRANT ${binding.privileges} ON public.${identifier(binding.name)} TO ${identifier('cm_protected_int_platform')}`,
  ]) });
}

export async function grantSyntheticParticipantRuntimeRoles(pool,input,options={}) {
  try { return await grantIncrementalRuntimeRoles(pool,syntheticParticipantRoleGrantPlan(input),options); }
  catch { failed(); }
}
