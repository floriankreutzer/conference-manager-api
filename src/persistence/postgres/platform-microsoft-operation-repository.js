import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { normalizePlatformPrincipal } from '../../platform/identity/principal.js';
import { normalizePlatformAuditEvent } from '../../platform/audit/event.js';
import { withPostgresTransaction } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope,requireProtectedSyntheticExecutionScope }
  from './protected-runtime-execution-scopes.js';

const HASH=/^[a-f0-9]{64}$/;
const LOOKUP=['environment','protectedSecurityEpoch','securityEpoch','stateHash','browserHash'];
const fail=()=>{ throw new TypeError('PLATFORM_MICROSOFT_PROOF_REPOSITORY_INVALID'); };
function exact(value,fields) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if (keys.length!==fields.length || keys.some(key=>!fields.includes(key) || !Object.hasOwn(descriptors[key],'value'))) fail();
}
function date(value) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail();return value; }
function rowView(row) {
  if (!row) return null;
  return Object.freeze({ id: row.id,status: row.status,operatorId: row.operator_id,
    operatorSecurityVersion: Number(row.operator_security_version),expectedSessionId: row.expected_session_id,
    operationHash: row.operation_hash,nonceHash: row.nonce_hash,correlationId: row.correlation_id,
    providerIdentity: Object.freeze({ provider: PLATFORM_ENTRA_PROVIDER,
      tenantReference: row.provider_tenant_reference,subjectReference: row.provider_subject_reference }),
    createdAt: date(row.created_at).toISOString(),expiresAt: date(row.expires_at).toISOString() });
}
function sameSource(left,right) {
  return left.operatorId===right.operatorId && left.securityVersion===right.securityVersion
    && left.session.id===right.session.id && left.session.securityEpoch===right.session.securityEpoch
    && left.roles.join(',')===right.roles.join(',') && left.permissions.join(',')===right.permissions.join(',')
    && left.targetScope.mode===right.targetScope.mode && left.assurance.authenticatedAt===right.assurance.authenticatedAt
    && ['provider','tenantReference','subjectReference'].every(key=>left.providerIdentity[key]===right.providerIdentity[key]);
}

// Root-owned fixed execution class. Callback verification grants no transaction
// choice; final consumption rechecks that class before entering its actual scope.
export function createPostgresPlatformMicrosoftOperationRepository(pool,{ environment,protectedSecurityEpoch,securityEpoch,
  executionScope,scopes,auditRepository }={}) {
  if (typeof pool?.connect!=='function' || typeof pool?.query!=='function' || !['dev','int','prod'].includes(environment)
    || !isInternalUuid(protectedSecurityEpoch) || !Number.isSafeInteger(securityEpoch) || securityEpoch<1
    || !['shared','synthetic'].includes(executionScope) || executionScope==='synthetic' && environment==='prod'
    || ['withShared','withSyntheticExclusive'].some(name=>typeof scopes?.[name]!=='function')
    || typeof auditRepository?.appendWithClient!=='function') fail();
  const epoch=protectedSecurityEpoch.toLowerCase(),protection=Object.freeze({ environment,securityEpoch: epoch });
  function lookup(value) {
    if (value.environment!==environment || value.protectedSecurityEpoch!==epoch || value.securityEpoch!==securityEpoch
      || !HASH.test(value.stateHash || '') || !HASH.test(value.browserHash || '')) fail();
    return [environment,epoch,securityEpoch,value.stateHash,value.browserHash];
  }
  async function shared(work,readOnly=false) {
    return scopes.withShared(()=>{
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      return withPostgresTransaction(pool,work,{ readOnly });
    });
  }
  async function load(client,value,lock=false) {
    const result=await client.query({ text: `SELECT proof.* FROM platform_microsoft_operation_proofs proof
      WHERE proof.environment=$1 AND proof.protected_security_epoch=$2 AND proof.security_epoch=$3
        AND proof.state_hash=$4 AND proof.browser_hash=$5 AND proof.status IN ('pending','verified')
        AND proof.expires_at>clock_timestamp() ${lock ? 'FOR UPDATE OF proof' : ''}`,values: lookup(value) });
    return result.rows[0] ?? null;
  }
  async function currentSource(client,binding,exclusive=false) {
    const result=await client.query({ text: `SELECT actor.id AS operator_id,actor.security_version,actor.roles,actor.scope_mode,
        actor.provider_tenant_reference,actor.provider_subject_reference,source.id AS session_id,source.permissions,
        source.issued_at,source.expires_at,source.authenticated_at
      FROM platform_operators actor JOIN platform_sessions source ON source.operator_id=actor.id
      JOIN protected_runtime_deployments deployment ON deployment.environment=$1 AND deployment.security_epoch=$2
      WHERE actor.id=$3 AND actor.security_version=$4 AND actor.status='active' AND actor.provider=$5
        AND actor.provider_tenant_reference=$6 AND actor.provider_subject_reference=$7 AND source.id=$8
        AND source.principal_version=actor.security_version AND source.provider=actor.provider
        AND source.provider_tenant_reference=actor.provider_tenant_reference
        AND source.provider_subject_reference=actor.provider_subject_reference AND source.roles=actor.roles
        AND source.scope_mode=actor.scope_mode AND source.security_epoch=$9 AND source.assurance_level='mfa'
        AND source.authentication_context='cm:ms:mfa:v1' AND source.step_up_expires_at IS NULL
        AND source.revoked_at IS NULL AND source.expires_at>clock_timestamp()
        AND source.issued_at<=clock_timestamp()+interval '1 minute'
      FOR SHARE OF actor,deployment ${exclusive ? 'FOR UPDATE OF source' : 'FOR SHARE OF source'}`,
    values: [environment,epoch,binding.operator_id,binding.operator_security_version,PLATFORM_ENTRA_PROVIDER,
      binding.provider_tenant_reference,binding.provider_subject_reference,binding.expected_session_id,securityEpoch] });
    if (result.rowCount!==1) return null;const row=result.rows[0],version=Number(row.security_version);
    return normalizePlatformPrincipal({ operatorId: row.operator_id,securityVersion: version,roles: row.roles,
      permissions: row.permissions,targetScope: { mode: row.scope_mode,securityVersion: version },
      providerIdentity: { provider: PLATFORM_ENTRA_PROVIDER,tenantReference: row.provider_tenant_reference,
        subjectReference: row.provider_subject_reference },
      assurance: { level: 'mfa',authenticationContext: 'cm:ms:mfa:v1',authenticatedAt: date(row.authenticated_at).toISOString() },
      session: { id: row.session_id,securityVersion: version,securityEpoch,issuedAt: date(row.issued_at).toISOString(),
        expiresAt: date(row.expires_at).toISOString(),stepUpExpiresAt: null } });
  }
  function sourceBinding(principal) {
    principal=normalizePlatformPrincipal(principal);
    if (principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER || principal.assurance.level!=='mfa'
      || principal.assurance.authenticationContext!=='cm:ms:mfa:v1' || principal.session.securityEpoch!==securityEpoch) fail();
    return { operator_id: principal.operatorId,operator_security_version: principal.securityVersion,
      expected_session_id: principal.session.id,provider_tenant_reference: principal.providerIdentity.tenantReference,
      provider_subject_reference: principal.providerIdentity.subjectReference };
  }
  async function now(client) { return date((await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now); }
  async function append(client,event) {
    const stored=await auditRepository.appendWithClient(client,normalizePlatformAuditEvent(event));
    if (!stored || !/^[1-9]\d{0,18}$/.test(String(stored.sequence)) || stored.operatorId!==event.operatorId
      || stored.action!==event.action || stored.targetType!==event.targetType || stored.targetId!==event.targetId) {
      throw new Error('PLATFORM_MICROSOFT_PROOF_AUDIT_FAILED');
    }
    return String(stored.sequence);
  }
  return Object.freeze({
    async create(value) {
      exact(value,[...LOOKUP,'id','nonceHash','operationHash','correlationId','expectedPrincipal','ttlSeconds']);lookup(value);
      if (!isInternalUuid(value.id) || !isInternalUuid(value.correlationId) || !HASH.test(value.nonceHash || '')
        || !HASH.test(value.operationHash || '') || value.ttlSeconds!==120) fail();
      const expected=normalizePlatformPrincipal(value.expectedPrincipal),binding=sourceBinding(expected);
      return shared(async client=>{
        const source=await currentSource(client,binding);if (!source || !sameSource(source,expected)) return false;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,714534))',[source.operatorId]);
        await client.query({ text: `DELETE FROM platform_microsoft_operation_proofs WHERE id IN (
          SELECT proof.id FROM platform_microsoft_operation_proofs proof WHERE environment=$1 AND operator_id=$2
            AND expires_at<=clock_timestamp() AND (status<>'consumed' OR consumed_at<clock_timestamp()-interval '24 hours')
            AND NOT EXISTS(SELECT 1 FROM synthetic_customer_handoffs custody WHERE custody.approval_microsoft_proof_id=proof.id)
          ORDER BY expires_at,id LIMIT 64 FOR UPDATE SKIP LOCKED)`,values: [environment,source.operatorId] });
        const inserted=await client.query({ text: `WITH database_time AS (SELECT clock_timestamp() AS now)
          INSERT INTO platform_microsoft_operation_proofs(id,environment,protected_security_epoch,security_epoch,
            operator_id,operator_security_version,expected_session_id,execution_scope,state_hash,browser_hash,nonce_hash,
            operation_hash,provider_tenant_reference,provider_subject_reference,correlation_id,created_at,expires_at)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now,now+interval '120 seconds'
          FROM database_time WHERE (SELECT count(*) FROM platform_microsoft_operation_proofs
            WHERE operator_id=$5 AND expires_at>now)<5 RETURNING id`,
        values: [value.id,environment,epoch,securityEpoch,source.operatorId,source.securityVersion,source.session.id,executionScope,
          value.stateHash,value.browserHash,value.nonceHash,value.operationHash,source.providerIdentity.tenantReference,
          source.providerIdentity.subjectReference,value.correlationId] });return inserted.rowCount===1;
      });
    },
    async findPending(value) {
      exact(value,LOOKUP);lookup(value);return shared(async client=>rowView(await load(client,value)),true);
    },
    async verify(value) {
      exact(value,[...LOOKUP,'id','identity']);lookup(value);if (!isInternalUuid(value.id)) fail();
      exact(value.identity,['provider','tenantReference','subjectReference','assurance']);
      exact(value.identity.assurance,['level','authenticationContext','authenticatedAt']);
      const identity=value.identity,authenticatedAt=new Date(identity.assurance.authenticatedAt);
      if (identity.provider!==PLATFORM_ENTRA_PROVIDER || !isInternalUuid(identity.tenantReference)
        || !isInternalUuid(identity.subjectReference) || identity.assurance.level!=='step_up'
        || identity.assurance.authenticationContext!=='cm:ms:fresh:v1' || !Number.isFinite(authenticatedAt.getTime())
        || authenticatedAt.toISOString()!==identity.assurance.authenticatedAt) fail();
      return shared(async client=>{
        const initial=await load(client,value);if (!initial || initial.id!==value.id || initial.status!=='pending') return false;
        const source=await currentSource(client,initial);if (!source) return false;
        const row=await load(client,value,true);
        if (!row || row.id!==value.id || row.status!=='pending' || row.provider_tenant_reference!==identity.tenantReference
          || row.provider_subject_reference!==identity.subjectReference) return false;
        const time=await now(client);
        if (authenticatedAt.getTime()<date(row.created_at).getTime()-60000 || authenticatedAt.getTime()>time.getTime()+60000) return false;
        const sequence=await append(client,{ operatorId: source.operatorId,roles: source.roles,permissions: source.permissions,
          assuranceLevel: 'step_up',targetTenantId: null,action: 'platform.authentication.succeeded',
          targetType: 'platform_microsoft_operation',targetId: source.operatorId,previousState: null,newState: null,
          occurredAt: time.toISOString(),correlationId: row.correlation_id,outcome: 'success',
          metadata: { operation: 'microsoft_operation_verified' },retentionClass: 'security' });
        const verifiedAt=await now(client);
        const result=await client.query({ text: `UPDATE platform_microsoft_operation_proofs
          SET status='verified',verified_at=$2,authenticated_at=$3,verified_audit_sequence=$4 WHERE id=$1 RETURNING id`,
        values: [row.id,verifiedAt,authenticatedAt,sequence] });return result.rowCount===1;
      });
    },
    async reject(value) {
      exact(value,LOOKUP);lookup(value);
      return shared(async client=>{
        const row=await load(client,value,true);if (!row) return false;
        const time=await now(client);
        await append(client,{ operatorId: null,roles: [],permissions: [],assuranceLevel: 'unverified',targetTenantId: null,
          action: 'platform.authentication.failed',targetType: 'platform_microsoft_operation',targetId: 'request',
          previousState: null,newState: null,occurredAt: time.toISOString(),correlationId: row.correlation_id,outcome: 'failure',
          metadata: { reasonCode: 'operation_rejected' },retentionClass: 'security' });
        const failedAt=await now(client);
        const result=await client.query({ text: `UPDATE platform_microsoft_operation_proofs
          SET status='failed',failed_at=$2 WHERE id=$1 RETURNING id`,values: [row.id,failedAt] });return result.rowCount===1;
      });
    },
    async authenticate(value,work) {
      exact(value,[...LOOKUP,'id','operationHash','expectedPrincipal']);lookup(value);
      if (!isInternalUuid(value.id) || !HASH.test(value.operationHash || '') || typeof work!=='function') fail();
      const expected=normalizePlatformPrincipal(value.expectedPrincipal),binding=sourceBinding(expected);
      const run=async client=>{
        if (executionScope==='synthetic') requireProtectedSyntheticExecutionScope(pool,client,{ ...protection,
          operatorId: expected.operatorId,operatorSecurityVersion: expected.securityVersion });
        else requireProtectedRuntimeSharedExecutionScope(pool,protection);
        const source=await currentSource(client,binding,true);if (!source || !sameSource(source,expected)) return null;
        const row=await load(client,value,true);
        if (!row || row.id!==value.id || row.status!=='verified' || row.execution_scope!==executionScope
          || row.operation_hash!==value.operationHash || row.operator_id!==source.operatorId
          || Number(row.operator_security_version)!==source.securityVersion || row.expected_session_id!==source.session.id) return null;
        const time=await now(client),result=await client.query({ text: `UPDATE platform_microsoft_operation_proofs
          SET status='consumed',consumed_at=$2 WHERE id=$1 RETURNING id`,values: [row.id,time] });
        if (result.rowCount!==1) return null;
        return work(Object.freeze({ operatorId: source.operatorId,providerIdentity: source.providerIdentity,roles: source.roles,
          securityVersion: source.securityVersion,scopeMode: source.targetScope.mode,
          authenticatedAt: date(row.authenticated_at).toISOString(),correlationId: row.correlation_id }));
      };
      return executionScope==='synthetic'
        ? scopes.withSyntheticExclusive({ operatorId: expected.operatorId,operatorSecurityVersion: expected.securityVersion },
          ()=>withPostgresTransaction(pool,run)) : shared(run);
    },
  });
}
