import { randomBytes, randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePlatformPasskeyEnrollmentBinding,
  createPlatformPasskeyEnrollmentGrant } from '../../platform/identity/passkey-enrollment-grant.js';
import { normalizePlatformPrincipal } from '../../platform/identity/principal.js';
import { normalizePlatformAuditEvent } from '../../platform/audit/event.js';
import { permissionsForPlatformRoles } from '../../platform/identity/policy.js';
import { withPostgresTransaction } from './transaction.js';
import { insertPlatformPasskeyEnrollmentGrant } from './platform-passkey-grant-write.js';

const HASH = /^[0-9a-f]{64}$/;
const LOOKUP = ['stateHash', 'browserHash', 'environment', 'securityEpoch'];
const BINDING = ['operatorId', 'operatorSecurityVersion', 'providerIdentity', 'environment', 'securityEpoch'];
function invalid() { throw new TypeError('PLATFORM_PASSKEY_ENROLLMENT_RECORD_INVALID'); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid();
}
function binary(value, min, max = min) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < min || bytes.length > max || bytes.toString('base64url') !== value) invalid();
  return value;
}
function lookup(value, response = false) {
  exact(value, [...LOOKUP, ...(response ? ['response'] : [])]);
  if (!HASH.test(value.stateHash || '') || !HASH.test(value.browserHash || '')
    || !['dev', 'int', 'prod'].includes(value.environment)
    || !Number.isSafeInteger(value.securityEpoch) || value.securityEpoch < 1) invalid();
}
function grantBinding(row) {
  return normalizePlatformPasskeyEnrollmentBinding({ operatorId: row.operator_id,
    operatorSecurityVersion: Number(row.operator_security_version), environment: row.environment,
    securityEpoch: Number(row.security_epoch), providerIdentity: { provider: row.provider,
      tenantReference: row.provider_tenant_reference, subjectReference: row.provider_subject_reference } });
}
async function lockOperator(client, value) {
  const result = await client.query({ name: 'platform-passkey-enrollment-operator-lock',
    text: `SELECT id,roles,security_version FROM platform_operators WHERE id = $1 AND status = 'active'
      AND security_version = $2 AND provider = $3 AND lower(provider_tenant_reference) = $4
      AND lower(provider_subject_reference) = $5 FOR UPDATE`,
    values: [value.operatorId,value.operatorSecurityVersion,value.providerIdentity.provider,
      value.providerIdentity.tenantReference,value.providerIdentity.subjectReference] });
  return result.rows[0] || null;
}
async function activeIds(client, operatorId, environment) {
  const keys = await client.query({ name: 'platform-passkey-enrollment-active-ids',
    text: `SELECT credential_id FROM platform_passkey_credentials WHERE operator_id = $1 AND environment = $2
      AND revoked_at IS NULL ORDER BY id LIMIT 6`, values: [operatorId, environment] });
  if (keys.rows.length > 5) invalid();
  return keys.rows.map(row => binary(row.credential_id, 1, 1024));
}
function event(operator, record, success, phase) {
  return normalizePlatformAuditEvent({ operatorId: success ? operator.id : null,
    roles: success ? operator.roles : [], permissions: success ? permissionsForPlatformRoles(operator.roles) : [],
    assuranceLevel: success ? 'mfa' : 'unverified', targetTenantId: null,
    action: success ? 'platform.operator.changed' : 'platform.authentication.failed',
    targetType: 'platform_passkey_enrollment', targetId: record.id, previousState: null,
    newState: success ? { operatorSecurityVersion: Number(operator.security_version) } : null,
    occurredAt: record.database_time.toISOString(), correlationId: record.correlation_id,
    outcome: success ? 'success' : 'denied', metadata: { phase }, retentionClass: 'security' });
}
const PENDING_SQL = `SELECT t.*,g.operator_id,g.operator_security_version,g.environment,g.security_epoch,
  g.provider,g.provider_tenant_reference,g.provider_subject_reference,g.kind
  FROM platform_passkey_enrollment_transactions t JOIN platform_passkey_enrollment_grants g ON g.id = t.grant_id
  WHERE t.state_hash = $1 AND t.browser_hash = $2 AND g.environment = $3 AND g.security_epoch = $4
    AND g.consumed_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > clock_timestamp()
    AND t.consumed_at IS NULL AND t.expires_at > clock_timestamp()`;
const parameters = value => [value.stateHash,value.browserHash,value.environment,value.securityEpoch];

function strongPrincipal(value) {
  const principal = normalizePlatformPrincipal(value.principal);
  if (principal.assurance.level !== 'step_up' || principal.assurance.authenticationContext !== 'cm:pk:v1'
    || principal.session.securityEpoch !== value.securityEpoch || !isInternalUuid(value.correlationId)
    || !['dev', 'int', 'prod'].includes(value.environment)) invalid();
  return principal;
}
async function lockStrongSession(client, principal, epoch) {
  const session = await client.query({ name: 'platform-passkey-lifecycle-session-lock',
    text: `SELECT id FROM platform_sessions WHERE id=$1 AND operator_id=$2 AND principal_version=$3
      AND security_epoch=$4 AND revoked_at IS NULL AND expires_at > clock_timestamp()
      AND assurance_level='step_up' AND authentication_context='cm:pk:v1'
      AND step_up_expires_at > clock_timestamp() FOR UPDATE`,
    values: [principal.session.id,principal.operatorId,principal.securityVersion,epoch] });
  return session.rowCount === 1;
}

export function createPostgresPlatformPasskeyEnrollmentRepository(pool, { auditRepository } = {}) {
  if (typeof pool?.connect !== 'function' || typeof pool?.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof auditRepository?.appendWithClient !== 'function') throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');

  async function perform(value, verify, phase) {
    lookup(value, true);
    if (typeof verify !== 'function') invalid();
    return withPostgresTransaction(pool, async client => {
      const found = await client.query({ name: 'platform-passkey-enrollment-locate', text: PENDING_SQL, values: parameters(value) });
      const row = found.rows[0];
      if (!row) return null;
      const binding = grantBinding(row);
      const operator = await lockOperator(client, binding);
      if (!operator) return null;
      const grant = await client.query({ name: 'platform-passkey-enrollment-grant-lock',
        text: `SELECT id FROM platform_passkey_enrollment_grants WHERE id = $1
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`, values: [row.grant_id] });
      if (grant.rowCount !== 1) return null;
      const locked = await client.query({ name: 'platform-passkey-enrollment-transaction-lock',
        text: `${PENDING_SQL} FOR UPDATE OF t`, values: parameters(value) });
      const record = locked.rows[0];
      if (!record || (phase === 'registration' ? record.staged_at !== null || record.registration_attempts >= 5
        : record.staged_at === null || record.possession_attempts >= 5)) return null;
      const attempted = await client.query({
        name: phase === 'registration' ? 'platform-passkey-enrollment-register-attempt' : 'platform-passkey-enrollment-prove-attempt',
        text: phase === 'registration'
          ? `UPDATE platform_passkey_enrollment_transactions SET registration_attempts = registration_attempts + 1
              WHERE id = $1 RETURNING clock_timestamp() AS database_time`
          : `UPDATE platform_passkey_enrollment_transactions SET possession_attempts = possession_attempts + 1
              WHERE id = $1 RETURNING clock_timestamp() AS database_time`, values: [record.id] });
      record.database_time = attempted.rows[0].database_time;
      async function denied() { await auditRepository.appendWithClient(client, event(operator, record, false, phase)); return null; }
      let proof;
      try {
        if (phase === 'registration') {
          proof = await verify({ registrationChallenge: binary(record.registration_challenge, 32) });
        } else {
          proof = await verify({ operatorId: binding.operatorId, possessionChallenge: binary(record.possession_challenge, 32),
            credential: { id: binary(record.candidate_id, 1, 1024), publicKey: binary(record.candidate_public_key, 32, 256),
              counter: Number(record.candidate_counter), backupEligible: record.candidate_backup_eligible,
              operatorId: binding.operatorId, environment: binding.environment, userHandle: binary(record.user_handle, 32) } });
        }
      } catch (error) {
        if (error?.code !== 'PLATFORM_PASSKEY_REJECTED') throw error;
        return denied();
      }
      if (phase === 'registration') {
        exact(proof, ['id','publicKey','counter','backupEligible','backedUp']);
        binary(proof.id, 1, 1024); binary(proof.publicKey, 32, 256);
        if (!Number.isSafeInteger(proof.counter) || proof.counter < 0 || proof.counter > 0xffffffff
          || typeof proof.backupEligible !== 'boolean' || typeof proof.backedUp !== 'boolean'
          || (proof.backedUp && !proof.backupEligible)) invalid();
        const duplicate = await client.query({ name: 'platform-passkey-enrollment-duplicate-key',
          text: 'SELECT id FROM platform_passkey_credentials WHERE environment = $1 AND credential_id = $2 LIMIT 1',
          values: [binding.environment,proof.id] });
        if (duplicate.rowCount !== 0) return denied();
        const staged = await client.query({ name: 'platform-passkey-enrollment-stage',
          text: `UPDATE platform_passkey_enrollment_transactions SET candidate_id = $2,candidate_public_key = $3,
            candidate_counter = $4,candidate_backup_eligible = $5,candidate_backed_up = $6,staged_at = clock_timestamp()
            WHERE id = $1 AND expires_at > clock_timestamp() RETURNING possession_challenge`,
          values: [record.id,proof.id,proof.publicKey,proof.counter,proof.backupEligible,proof.backedUp] });
        if (staged.rowCount !== 1) return denied();
        return Object.freeze({ possessionChallenge: binary(staged.rows[0].possession_challenge, 32), credentialId: proof.id });
      }
      exact(proof, ['credentialId','newCounter','backupEligible','backedUp']);
      if (proof.credentialId !== record.candidate_id || !Number.isSafeInteger(proof.newCounter)
        || proof.newCounter < Number(record.candidate_counter) || proof.newCounter > 0xffffffff
        || proof.backupEligible !== record.candidate_backup_eligible || typeof proof.backedUp !== 'boolean'
        || (proof.backedUp && !proof.backupEligible)) invalid();
      const consumed = await client.query({ name: 'platform-passkey-enrollment-consume',
        text: `UPDATE platform_passkey_enrollment_transactions SET consumed_at = clock_timestamp()
          WHERE id = $1 AND expires_at > clock_timestamp() RETURNING consumed_at`, values: [record.id] });
      if (consumed.rowCount !== 1) return denied();
      const redeemed = await client.query({ name: 'platform-passkey-enrollment-redeem-grant',
        text: `UPDATE platform_passkey_enrollment_grants SET consumed_at = clock_timestamp()
          WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING id`,
        values: [record.grant_id] });
      if (redeemed.rowCount !== 1) throw new Error('PLATFORM_PASSKEY_ENROLLMENT_REDEMPTION_FAILED');
      await client.query({ name: 'platform-passkey-enrollment-insert-key',
        text: `INSERT INTO platform_passkey_credentials
          (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        values: [randomUUID(),binding.operatorId,binding.environment,record.candidate_id,record.candidate_public_key,
          record.user_handle,proof.newCounter,proof.backupEligible,proof.backedUp] });
      const current = await client.query({ name: 'platform-passkey-enrollment-new-version',
        text: 'SELECT id,roles,security_version,clock_timestamp() AS database_time FROM platform_operators WHERE id = $1',
        values: [binding.operatorId] });
      record.database_time = current.rows[0].database_time;
      await auditRepository.appendWithClient(client, event(current.rows[0], record, true, 'possession'));
      return true;
    });
  }

  return Object.freeze({
    async listActive(value) {
      exact(value, ['principal','environment','securityEpoch']);
      const principal = normalizePlatformPrincipal(value.principal);
      if (!['dev','int','prod'].includes(value.environment) || principal.session.securityEpoch !== value.securityEpoch) invalid();
      return withPostgresTransaction(pool, async client => {
        const result = await client.query({ name: 'platform-passkey-own-key-list',
          text: `SELECT c.credential_id,c.created_at,c.last_used_at,c.backup_eligible,c.backed_up
            FROM platform_sessions s JOIN platform_operators o ON o.id=s.operator_id
            LEFT JOIN platform_passkey_credentials c ON c.operator_id=o.id AND c.environment=$4 AND c.revoked_at IS NULL
            WHERE s.id=$1 AND s.operator_id=$2 AND s.principal_version=$3 AND s.security_epoch=$5
              AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
              AND o.status='active' AND o.security_version=s.principal_version ORDER BY c.created_at,c.id LIMIT 6`,
          values: [principal.session.id,principal.operatorId,principal.securityVersion,value.environment,value.securityEpoch] });
        if (!result.rowCount) return null;
        const rows = result.rows.filter(row => row.credential_id !== null);
        if (rows.length > 5) invalid();
        return Object.freeze(rows.map(row => Object.freeze({ id: binary(row.credential_id, 1, 1024),
          createdAt: row.created_at.toISOString(), lastUsedAt: row.last_used_at?.toISOString() ?? null,
          backupEligible: row.backup_eligible, backedUp: row.backed_up })));
      });
    },
    async issueAdditional(value) {
      exact(value, ['principal','environment','securityEpoch','correlationId']);
      const principal = strongPrincipal(value);
      const issued = createPlatformPasskeyEnrollmentGrant({ operatorId: principal.operatorId,
        operatorSecurityVersion: principal.securityVersion, providerIdentity: principal.providerIdentity,
        environment: value.environment, securityEpoch: value.securityEpoch, kind: 'additional',
        approvalReference: `PASSKEY-ADDITION:${value.correlationId.toUpperCase()}`, issuedFromSessionId: principal.session.id,
        ttlSeconds: 120, correlationId: value.correlationId });
      return withPostgresTransaction(pool, async client => {
        if (!await lockOperator(client, issued.record)) return null;
        if (!await lockStrongSession(client, principal, value.securityEpoch)) return null;
        const actor = (await client.query('SELECT current_user AS role')).rows[0]?.role;
        if (typeof actor !== 'string' || !/^[a-z][a-z0-9_]{2,62}$/.test(actor)) invalid();
        const persisted = await insertPlatformPasskeyEnrollmentGrant(client, issued.record, actor);
        await auditRepository.appendWithClient(client, normalizePlatformAuditEvent({ operatorId: principal.operatorId,
          roles: principal.roles, permissions: principal.permissions, assuranceLevel: 'step_up', targetTenantId: null,
          action: 'platform.operator.changed', targetType: 'platform_passkey_grant', targetId: issued.record.id,
          previousState: null, newState: { kind: 'additional', environment: value.environment },
          occurredAt: persisted.created_at.toISOString(), correlationId: value.correlationId, outcome: 'success',
          metadata: { operation: 'passkey_grant_issued' }, retentionClass: 'security' }));
        return Object.freeze({ grant: issued.grant, expiresAt: persisted.expires_at.toISOString(),
          operatorSecurityVersion: principal.securityVersion });
      });
    },
    async revokeCredential(value) {
      exact(value, ['principal','environment','securityEpoch','correlationId','credentialId']);
      const principal = strongPrincipal(value);
      binary(value.credentialId, 1, 1024);
      const binding = { operatorId: principal.operatorId, operatorSecurityVersion: principal.securityVersion,
        providerIdentity: principal.providerIdentity, environment: value.environment, securityEpoch: value.securityEpoch };
      return withPostgresTransaction(pool, async client => {
        if (!await lockOperator(client, binding) || !await lockStrongSession(client, principal, value.securityEpoch)) return null;
        const target = await client.query({ name: 'platform-passkey-revoke-own-key-lock',
          text: `SELECT id FROM platform_passkey_credentials WHERE operator_id=$1 AND environment=$2
            AND credential_id=$3 AND revoked_at IS NULL FOR UPDATE`,
          values: [principal.operatorId,value.environment,value.credentialId] });
        if (target.rowCount !== 1) return null;
        const keys = await activeIds(client, principal.operatorId, value.environment);
        if (keys.length < 2) return null; // The last key requires independent recovery authority.
        await client.query({ name: 'platform-passkey-revoke-own-key',
          text: 'UPDATE platform_passkey_credentials SET revoked_at=clock_timestamp() WHERE id=$1', values: [target.rows[0].id] });
        await client.query({ name: 'platform-passkey-revoke-old-enrollment-grants',
          text: `UPDATE platform_passkey_enrollment_grants SET revoked_at=clock_timestamp()
            WHERE operator_id=$1 AND environment=$2 AND consumed_at IS NULL AND revoked_at IS NULL`,
          values: [principal.operatorId,value.environment] });
        // The caller revokes its temporary verification session before returning.
        // Keep that exact row live until then so all work can commit atomically.
        const revoked = await client.query({ name: 'platform-passkey-revoke-other-sessions',
          text: `UPDATE platform_sessions SET revoked_at=clock_timestamp()
            WHERE operator_id=$1 AND id<>$2 AND revoked_at IS NULL RETURNING id`,
          values: [principal.operatorId,principal.session.id] });
        const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
        await auditRepository.appendWithClient(client, normalizePlatformAuditEvent({ operatorId: principal.operatorId,
          roles: principal.roles, permissions: principal.permissions, assuranceLevel: 'step_up', targetTenantId: null,
          action: 'platform.operator.changed', targetType: 'platform_passkey', targetId: target.rows[0].id,
          previousState: { status: 'active' }, newState: { status: 'revoked', remainingKeys: keys.length - 1 },
          occurredAt: now.toISOString(), correlationId: value.correlationId, outcome: 'success',
          metadata: { operation: 'passkey_revoked', revokedSessions: revoked.rowCount }, retentionClass: 'security' }));
        return Object.freeze({ status: 'credential_revoked' });
      });
    },
    async begin(value) {
      exact(value, [...BINDING,'grantId','tokenHash','id','stateHash','browserHash','registrationChallenge',
        'possessionChallenge','correlationId','ttlSeconds']);
      const binding = normalizePlatformPasskeyEnrollmentBinding(Object.fromEntries(BINDING.map(key => [key,value[key]])));
      if (![value.id,value.grantId,value.correlationId].every(isInternalUuid)
        || ![value.stateHash,value.browserHash,value.tokenHash].every(hash => HASH.test(hash || ''))
        || !Number.isInteger(value.ttlSeconds) || value.ttlSeconds < 60 || value.ttlSeconds > 300) invalid();
      binary(value.registrationChallenge, 32); binary(value.possessionChallenge, 32);
      if (value.registrationChallenge === value.possessionChallenge) invalid();
      return withPostgresTransaction(pool, async client => {
        if (!await lockOperator(client, binding)) return null;
        const grants = await client.query({ name: 'platform-passkey-enrollment-claim-grant',
          text: `SELECT id,kind,expires_at FROM platform_passkey_enrollment_grants
            WHERE id = $1 AND token_hash = $2 AND operator_id = $3 AND operator_security_version = $4
              AND environment = $5 AND security_epoch = $6 AND consumed_at IS NULL AND revoked_at IS NULL
              AND expires_at > clock_timestamp() FOR UPDATE`,
          values: [value.grantId,value.tokenHash,binding.operatorId,binding.operatorSecurityVersion,
            binding.environment,binding.securityEpoch] });
        const grant = grants.rows[0];
        if (!grant) return null;
        const handles = await client.query({ name: 'platform-passkey-enrollment-existing-handles',
          text: `SELECT DISTINCT user_handle FROM platform_passkey_credentials
            WHERE operator_id = $1 AND environment = $2 LIMIT 2`, values: [binding.operatorId,binding.environment] });
        if (handles.rows.length > 1 || (grant.kind === 'bootstrap' && handles.rows.length !== 0)) return null;
        const ids = await activeIds(client, binding.operatorId, binding.environment);
        if (ids.length >= 5 || (grant.kind === 'additional' ? ids.length === 0 : ids.length !== 0)) return null;
        const userHandle = handles.rows.length ? binary(handles.rows[0].user_handle, 32) : randomBytes(32).toString('base64url');
        const inserted = await client.query({ name: 'platform-passkey-enrollment-begin',
          text: `WITH database_time AS (SELECT clock_timestamp() AS now)
            INSERT INTO platform_passkey_enrollment_transactions
              (id,grant_id,state_hash,browser_hash,registration_challenge,possession_challenge,
                user_handle,created_at,expires_at,correlation_id)
            SELECT $1,$2,$3,$4,$5,$6,$7,now,LEAST(now + ($8 * INTERVAL '1 second'),$9::timestamptz),$10 FROM database_time
            ON CONFLICT (grant_id) DO NOTHING RETURNING id`,
          values: [value.id,value.grantId,value.stateHash,value.browserHash,value.registrationChallenge,
            value.possessionChallenge,userHandle,value.ttlSeconds,grant.expires_at,value.correlationId] });
        if (inserted.rowCount !== 1) return null;
        return Object.freeze({ registrationChallenge: value.registrationChallenge, userHandle, excludeCredentialIds: ids });
      });
    },
    async findRegistration(value) {
      lookup(value);
      return withPostgresTransaction(pool, async client => {
        const result = await client.query({ name: 'platform-passkey-enrollment-registration-options',
          text: `${PENDING_SQL} AND t.staged_at IS NULL AND t.registration_attempts < 5`, values: parameters(value) });
        const record = result.rows[0];
        if (!record || !await lockOperator(client, grantBinding(record))) return null;
        return Object.freeze({ registrationChallenge: binary(record.registration_challenge, 32),
          userHandle: binary(record.user_handle, 32),
          excludeCredentialIds: await activeIds(client, record.operator_id, record.environment) });
      });
    },
    async stageCredential(value, verify) { return perform(value, verify, 'registration'); },
    async findPossession(value) {
      lookup(value);
      return withPostgresTransaction(pool, async client => {
        const result = await client.query({ name: 'platform-passkey-enrollment-possession-options',
          text: `${PENDING_SQL} AND t.staged_at IS NOT NULL AND t.possession_attempts < 5`, values: parameters(value) });
        const record = result.rows[0];
        if (!record || !await lockOperator(client, grantBinding(record))) return null;
        return Object.freeze({ possessionChallenge: binary(record.possession_challenge, 32),
          credentialId: binary(record.candidate_id, 1, 1024) });
      });
    },
    async complete(value, verify) { return perform(value, verify, 'possession'); },
  });
}
