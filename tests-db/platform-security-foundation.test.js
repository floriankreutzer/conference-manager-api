import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import {
  PLATFORM_AUDIT_ACTION,
  PLATFORM_AUDIT_OUTCOME,
  PLATFORM_AUDIT_RETENTION,
  normalizePlatformAuditEvent,
} from '../src/platform/audit/event.js';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { PlatformAuditIntegrityError } from '../src/platform/audit/errors.js';
import {
  createPlatformBreakGlassGrant,
} from '../src/platform/identity/break-glass.js';
import {
  PLATFORM_PERMISSION,
  PLATFORM_ROLE,
  createPlatformAuthorizationPolicy,
  permissionsForPlatformRoles,
} from '../src/platform/identity/policy.js';
import { createPlatformOperatorLifecycleService } from '../src/platform/identity/operator-lifecycle-service.js';
import { createPlatformSessionService } from '../src/platform/identity/session-service.js';
import { createPlatformTenantTargetPolicy } from '../src/platform/identity/tenant-target-policy.js';
import {
  PLATFORM_AUDIT_CHECKPOINT_INTERVAL,
  createPostgresPlatformAuditRepository,
} from '../src/persistence/postgres/platform-audit-repository.js';
import {
  createPostgresPlatformBreakGlassRepository,
} from '../src/persistence/postgres/platform-break-glass-repository.js';
import {
  createPostgresPlatformOidcTransactionRepository,
} from '../src/persistence/postgres/platform-oidc-transaction-repository.js';
import {
  createPostgresPlatformOperatorRepository,
} from '../src/persistence/postgres/platform-operator-repository.js';
import {
  createPostgresPlatformSessionRepository,
} from '../src/persistence/postgres/platform-session-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const OPERATOR_ID = 'a1111111-1111-4111-8111-111111111111';
const APPROVER_ID = 'a2222222-2222-4222-8222-222222222222';
const TENANT_ID = 'a3333333-3333-4333-8333-333333333333';
const OTHER_TENANT_ID = 'a4444444-4444-4444-8444-444444444444';
const SESSION_ID = 'a5555555-5555-4555-8555-555555555555';
const FAILED_SESSION_ID = 'a6666666-6666-4666-8666-666666666666';
const GRANT_ID = 'a7777777-7777-4777-8777-777777777777';
const FAILED_GRANT_ID = 'a8888888-8888-4888-8888-888888888888';
const CORRELATION_ID = 'a9999999-9999-4999-8999-999999999999';
const OPERATOR_CHANGE_CORRELATION_ID = 'b1111111-1111-4111-8111-111111111111';
const TARGET_OPERATOR_ID = 'b2222222-2222-4222-8222-222222222222';
const TARGET_SESSION_ID = 'b3333333-3333-4333-8333-333333333333';
const APPROVER_SESSION_ID = 'b4444444-4444-4444-8444-444444444444';
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAILED_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const BREAK_GLASS_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const TARGET_SESSION_TOKEN = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const APPROVER_SESSION_TOKEN = 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
const roles = [PLATFORM_ROLE.SECURITY_ADMIN];
const permissions = permissionsForPlatformRoles(roles);

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function cleanup(pool) {
  const present = await pool.query(
    "SELECT to_regclass('public.platform_audit_events') AS audit, to_regclass('public.platform_operators') AS operators",
  );
  if (!present.rows[0].operators) return;
  if (present.rows[0].audit) {
    await pool.query('ALTER TABLE platform_audit_checkpoints DISABLE TRIGGER platform_audit_checkpoints_append_only');
    await pool.query('ALTER TABLE platform_audit_events DISABLE TRIGGER platform_audit_events_append_only');
    try {
      await pool.query('DELETE FROM platform_audit_checkpoints');
      await pool.query('DELETE FROM platform_audit_events');
      await pool.query(`
        UPDATE platform_audit_chain_state
        SET event_count = 0, terminal_event_hash = NULL, terminal_checkpoint_hash = NULL
        WHERE singleton = true
      `);
    } finally {
      await pool.query('ALTER TABLE platform_audit_events ENABLE TRIGGER platform_audit_events_append_only');
      await pool.query('ALTER TABLE platform_audit_checkpoints ENABLE TRIGGER platform_audit_checkpoints_append_only');
    }
  }
  await pool.query('DELETE FROM platform_break_glass_alert_outbox');
  await pool.query('DELETE FROM platform_security_alert_outbox');
  await pool.query('DELETE FROM platform_operator_change_alert_outbox');
  await pool.query('ALTER TABLE platform_break_glass_grants DISABLE TRIGGER platform_break_glass_grant_protection');
  try {
    await pool.query('DELETE FROM platform_break_glass_grants');
  } finally {
    await pool.query('ALTER TABLE platform_break_glass_grants ENABLE TRIGGER platform_break_glass_grant_protection');
  }
  await pool.query('DELETE FROM platform_oidc_auth_transactions');
  await pool.query('DELETE FROM platform_sessions');
  await pool.query('DELETE FROM platform_operator_tenant_scopes');
  await pool.query('DELETE FROM platform_operators');
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[TENANT_ID, OTHER_TENANT_ID]]);
}

function identity(securityVersion, {
  operatorId = OPERATOR_ID,
  subjectReference = 'operator-subject',
} = {}) {
  const authenticatedAt = new Date(Date.now() - 30_000).toISOString();
  return {
    operatorId,
    providerIdentity: {
      provider: 'microsoft_entra_platform',
      tenantReference: 'operator-tenant',
      subjectReference,
    },
    roles,
    permissions,
    securityVersion,
    targetScope: { mode: 'allowlist', securityVersion },
    assurance: {
      level: 'step_up',
      authenticationContext: 'cm-platform-step-up',
      authenticatedAt,
    },
  };
}

function auditEvent({
  operatorId = OPERATOR_ID,
  action = PLATFORM_AUDIT_ACTION.RUNTIME_READ,
  targetTenantId = null,
  targetType = 'platform_runtime',
  targetId = 'fleet',
  assuranceLevel = 'step_up',
  metadata = {},
} = {}) {
  return normalizePlatformAuditEvent({
    operatorId,
    roles,
    permissions,
    assuranceLevel,
    targetTenantId,
    action,
    targetType,
    targetId,
    previousState: null,
    newState: null,
    occurredAt: new Date().toISOString(),
    correlationId: CORRELATION_ID,
    outcome: PLATFORM_AUDIT_OUTCOME.SUCCESS,
    metadata,
    retentionClass: PLATFORM_AUDIT_RETENTION.SECURITY,
  });
}

test('PostgreSQL Platform identity, scope, session, break-glass, OIDC and audit foundation', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const auditRepository = createPostgresPlatformAuditRepository(pool, {
    hmacSecret: 'platform-audit-postgres-test-secret-at-least-32-bytes',
  });
  const operatorRepository = createPostgresPlatformOperatorRepository(pool, { auditRepository });
  const sessionRepository = createPostgresPlatformSessionRepository(pool, { auditRepository });
  const breakGlassRepository = createPostgresPlatformBreakGlassRepository(pool, { auditRepository });
  const oidcRepository = createPostgresPlatformOidcTransactionRepository(pool);
  t.after(async () => {
    await cleanup(pool);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await cleanup(pool);
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3), ($4, $5, $3)',
    [TENANT_ID, 'Platform Security Tenant', 'active', OTHER_TENANT_ID, 'Other Platform Tenant'],
  );
  await pool.query(`
    INSERT INTO platform_operators (
      id, provider, provider_tenant_reference, provider_subject_reference,
      status, scope_mode, roles
    ) VALUES
      ($1, 'microsoft_entra_platform', 'operator-tenant', 'operator-subject', 'active', 'allowlist', $3::text[]),
      ($2, 'microsoft_entra_platform', 'operator-tenant', 'approver-subject', 'active', 'all', $3::text[])
  `, [OPERATOR_ID, APPROVER_ID, roles]);
  await pool.query(
    'INSERT INTO platform_operator_tenant_scopes (operator_id, tenant_id) VALUES ($1, $2)',
    [OPERATOR_ID, TENANT_ID],
  );
  const operator = await operatorRepository.findActiveByProviderIdentity({
    provider: 'microsoft_entra_platform',
    tenantReference: 'operator-tenant',
    subjectReference: 'operator-subject',
  });
  assert.equal(operator.securityVersion, 2);
  assert.equal(operator.scopeMode, 'allowlist');

  await assert.rejects(pool.query({
    text: `
      WITH database_time AS (SELECT clock_timestamp() AS issued_at)
      INSERT INTO platform_break_glass_grants (
        id, token_hash, operator_id, operator_security_version,
        approver_operator_id, approver_security_version, target_tenant_id,
        permission, reason, approval_reference, issued_at, expires_at, consumed_at
      )
      SELECT 'b5555555-5555-4555-8555-555555555555', $1, $2, 2, $3, 1, $4,
        'platform:recovery:execute', 'Reject consumption after the exact grant expiry',
        'INC-2026-EXPIRED', issued_at, issued_at + INTERVAL '5 minutes',
        issued_at + INTERVAL '6 minutes'
      FROM database_time
    `,
    values: ['f'.repeat(64), OPERATOR_ID, APPROVER_ID, TENANT_ID],
  }), (error) => error.code === '23514');

  const sessionService = createPlatformSessionService({
    repository: sessionRepository,
    publicOrigin: 'https://platform.example',
    csrfSecret: 'platform-csrf-postgres-test-secret-at-least-32-bytes',
    securityEpoch: 7,
    clock: () => Date.now(),
    tokenFactory: () => TOKEN,
    idFactory: () => SESSION_ID,
  });
  const tenantAuditBefore = await pool.query('SELECT count(*)::int AS count FROM audit_events');
  const issued = await sessionService.issue(identity(operator.securityVersion), {
    correlationId: CORRELATION_ID,
  });
  const storedSession = await pool.query(
    'SELECT token_hash, security_epoch, scope_mode FROM platform_sessions WHERE id = $1',
    [SESSION_ID],
  );
  assert.match(storedSession.rows[0].token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(storedSession.rows[0].token_hash, TOKEN);
  assert.doesNotMatch(JSON.stringify(storedSession.rows[0]), new RegExp(TOKEN));
  assert.equal(Number(storedSession.rows[0].security_epoch), 7);
  assert.equal(storedSession.rows[0].scope_mode, 'allowlist');
  assert.equal((await sessionService.resolvePrincipal({
    headers: { cookie: issued.setCookie.split(';')[0] },
  })).operatorId, OPERATOR_ID);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM platform_audit_events WHERE action = ANY($1::text[])',
    [[PLATFORM_AUDIT_ACTION.AUTHENTICATION_SUCCEEDED, PLATFORM_AUDIT_ACTION.SESSION_ISSUED]],
  )).rows[0].count, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM audit_events')).rows[0].count, tenantAuditBefore.rows[0].count);

  const targetPolicy = createPlatformTenantTargetPolicy({ operatorRepository });
  assert.equal(await targetPolicy.authorize(issued.principal, TENANT_ID), true);
  await assert.rejects(targetPolicy.authorize(issued.principal, OTHER_TENANT_ID));
  await assert.rejects(targetPolicy.authorizeCreation(issued.principal));
  assert.deepEqual(await targetPolicy.queryScope(issued.principal), {
    mode: 'allowlist',
    operatorId: OPERATOR_ID,
    securityVersion: 2,
  });

  const oidcStateHash = 'd'.repeat(64);
  await oidcRepository.create({
    stateHash: oidcStateHash,
    nonceHash: 'e'.repeat(64),
    purpose: 'step_up',
    expectedOperatorId: OPERATOR_ID,
    expectedSessionId: SESSION_ID,
    expectedSecurityVersion: 2,
    securityEpoch: 7,
    authenticationContext: 'cm-platform-step-up',
    correlationId: CORRELATION_ID,
    ttlSeconds: 300,
  });
  assert.equal(await oidcRepository.consume({ stateHash: oidcStateHash, securityEpoch: 8 }), null);
  const consumedOidc = await oidcRepository.consume({ stateHash: oidcStateHash, securityEpoch: 7 });
  assert.equal(consumedOidc.expectedSessionId, SESSION_ID);
  assert.equal(consumedOidc.correlationId, CORRELATION_ID);
  assert.equal(await oidcRepository.consume({ stateHash: oidcStateHash, securityEpoch: 7 }), null);

  const generatedGrant = createPlatformBreakGlassGrant({
    operatorId: OPERATOR_ID,
    operatorSecurityVersion: 2,
    approverOperatorId: APPROVER_ID,
    approverSecurityVersion: 1,
    targetTenantId: TENANT_ID,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    reason: 'Recover authoritative tenant administration access',
    approvalReference: 'INC-2026-0042',
    ttlSeconds: 600,
    idFactory: () => GRANT_ID,
    tokenFactory: () => BREAK_GLASS_TOKEN,
  });
  await breakGlassRepository.issue(generatedGrant.record, () => auditEvent({
    action: PLATFORM_AUDIT_ACTION.BREAK_GLASS_GRANTED,
    targetTenantId: TENANT_ID,
    targetType: 'platform_break_glass_grant',
    targetId: GRANT_ID,
  }));
  const consumedGrant = await breakGlassRepository.executeAuthorizedMutation({
    consumption: {
      token: BREAK_GLASS_TOKEN,
      operatorId: OPERATOR_ID,
      operatorSecurityVersion: 2,
      targetTenantId: TENANT_ID,
      permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    },
    eventFactory: () => auditEvent({
      action: PLATFORM_AUDIT_ACTION.BREAK_GLASS_USED,
      targetTenantId: TENANT_ID,
      targetType: 'platform_break_glass_grant',
      targetId: GRANT_ID,
      assuranceLevel: 'break_glass',
    }),
    deniedEventFactory: () => auditEvent({
      action: PLATFORM_AUDIT_ACTION.BREAK_GLASS_DENIED,
      targetTenantId: TENANT_ID,
      targetType: 'platform_break_glass_grant',
      targetId: 'attempt',
      metadata: { reasonCode: 'grant_rejected' },
    }),
    async mutation({ authorization }) { return authorization.id; },
  });
  assert.deepEqual(consumedGrant, { executed: true, result: GRANT_ID });
  const alerts = await pool.query(
    'SELECT event_type FROM platform_break_glass_alert_outbox WHERE grant_id = $1 ORDER BY event_type',
    [GRANT_ID],
  );
  assert.deepEqual(alerts.rows.map((row) => row.event_type), ['issued', 'used']);
  assert.equal(await breakGlassRepository.executeAuthorizedMutation({
    consumption: {
      token: BREAK_GLASS_TOKEN,
      operatorId: OPERATOR_ID,
      operatorSecurityVersion: 2,
      targetTenantId: TENANT_ID,
      permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    },
    eventFactory: () => auditEvent(),
    deniedEventFactory: () => auditEvent({
      action: PLATFORM_AUDIT_ACTION.BREAK_GLASS_DENIED,
      targetTenantId: TENANT_ID,
      targetType: 'platform_break_glass_grant',
      targetId: 'attempt',
      metadata: { reasonCode: 'grant_rejected' },
    }),
    async mutation() { throw new Error('BREAK_GLASS_REPLAY_MUTATION_MUST_NOT_RUN'); },
  }), null);

  const failingAuditRepository = { async appendWithClient() { throw new Error('EXPECTED_PLATFORM_AUDIT_FAILURE'); } };
  const failingBreakGlass = createPostgresPlatformBreakGlassRepository(pool, {
    auditRepository: failingAuditRepository,
  });
  const failedGrant = createPlatformBreakGlassGrant({
    operatorId: OPERATOR_ID,
    operatorSecurityVersion: 2,
    approverOperatorId: APPROVER_ID,
    approverSecurityVersion: 1,
    targetTenantId: TENANT_ID,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    reason: 'Test required audit and alert transaction rollback',
    approvalReference: 'INC-2026-0043',
    ttlSeconds: 300,
    idFactory: () => FAILED_GRANT_ID,
    tokenFactory: () => FAILED_TOKEN,
  });
  await assert.rejects(failingBreakGlass.issue(failedGrant.record, () => auditEvent({
    targetTenantId: TENANT_ID,
  })), /EXPECTED_PLATFORM_AUDIT_FAILURE/);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM platform_break_glass_grants WHERE id = $1',
    [FAILED_GRANT_ID],
  )).rows[0].count, 0);

  const failingSession = createPostgresPlatformSessionRepository(pool, {
    auditRepository: failingAuditRepository,
  });
  const failedSessionService = createPlatformSessionService({
    repository: failingSession,
    publicOrigin: 'https://platform.example',
    csrfSecret: 'platform-csrf-postgres-test-secret-at-least-32-bytes',
    securityEpoch: 7,
    clock: () => Date.now(),
    tokenFactory: () => FAILED_TOKEN,
    idFactory: () => FAILED_SESSION_ID,
  });
  await assert.rejects(failedSessionService.issue(identity(2)), /EXPECTED_PLATFORM_AUDIT_FAILURE/);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM platform_sessions WHERE id = $1',
    [FAILED_SESSION_ID],
  )).rows[0].count, 0);

  await Promise.all([
    auditRepository.append(auditEvent({ metadata: { concurrent: 1 } })),
    auditRepository.append(auditEvent({ metadata: { concurrent: 2 } })),
  ]);
  const state = await pool.query('SELECT event_count FROM platform_audit_chain_state WHERE singleton = true');
  const remaining = PLATFORM_AUDIT_CHECKPOINT_INTERVAL - (Number(state.rows[0].event_count) % PLATFORM_AUDIT_CHECKPOINT_INTERVAL);
  for (let index = 0; index < remaining; index += 1) {
    await auditRepository.append(auditEvent({ metadata: { checkpointFill: index } }));
  }
  assert.ok((await pool.query('SELECT count(*)::int AS count FROM platform_audit_checkpoints')).rows[0].count >= 1);
  const auditScope = await targetPolicy.queryScope(issued.principal);
  const verified = await auditRepository.listVerified({ limit: 100, scope: auditScope });
  assert.equal(verified[0].eventHash, undefined);
  assert.equal(verified[0].previousHash, undefined);

  const latest = await pool.query(
    'SELECT sequence, metadata FROM platform_audit_events ORDER BY sequence DESC LIMIT 1',
  );
  await pool.query('ALTER TABLE platform_audit_events DISABLE TRIGGER platform_audit_events_append_only');
  try {
    await pool.query(
      'UPDATE platform_audit_events SET metadata = $2::jsonb WHERE sequence = $1',
      [latest.rows[0].sequence, JSON.stringify({ tampered: true })],
    );
  } finally {
    await pool.query('ALTER TABLE platform_audit_events ENABLE TRIGGER platform_audit_events_append_only');
  }
  await assert.rejects(
    auditRepository.listVerified({ limit: 1, scope: auditScope }),
    PlatformAuditIntegrityError,
  );
  await pool.query('ALTER TABLE platform_audit_events DISABLE TRIGGER platform_audit_events_append_only');
  try {
    await pool.query(
      'UPDATE platform_audit_events SET metadata = $2::jsonb WHERE sequence = $1',
      [latest.rows[0].sequence, JSON.stringify(latest.rows[0].metadata)],
    );
  } finally {
    await pool.query('ALTER TABLE platform_audit_events ENABLE TRIGGER platform_audit_events_append_only');
  }
  await assert.rejects(
    pool.query('UPDATE platform_audit_events SET outcome = $2 WHERE sequence = $1', [latest.rows[0].sequence, 'failure']),
    (error) => error.code === '55000',
  );

  const auditDown = await readFile('migrations/030_platform_audit.down.sql', 'utf8');
  await assert.rejects(pool.query(auditDown), (error) => error.code === '55000');
  const identityDown = await readFile('migrations/029_platform_identity_sessions.down.sql', 'utf8');
  await assert.rejects(pool.query(identityDown), (error) => error.code === '55000');

  await pool.query("UPDATE platform_operators SET scope_mode = 'all' WHERE id = $1", [OPERATOR_ID]);
  assert.equal(await sessionService.resolvePrincipal({
    headers: { cookie: issued.setCookie.split(';')[0] },
  }), null);
  await assert.rejects(targetPolicy.authorize(issued.principal, TENANT_ID));
});
