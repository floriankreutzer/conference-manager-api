import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresPlatformPasskeyGrantIssuer } from '../src/persistence/postgres/platform-passkey-grant-issuer.js';
import { normalizePlatformAuditEvent } from '../src/platform/audit/event.js';
import { normalizeTrustedPlatformIdentity } from '../src/platform/identity/principal.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const request = () => ({ operatorId: ID, operatorSecurityVersion: 1, environment: 'int', securityEpoch: 8,
  providerIdentity: { provider: 'microsoft_entra_platform', tenantReference: ID, subjectReference: ID },
  kind: 'bootstrap', approvalReference: 'CM-INT-OWNER-001', ttlSeconds: 600, correlationId: ID });

test('offline issuer rejects caller authority before any database connection', async () => {
  let connections = 0;
  const issuer = createPostgresPlatformPasskeyGrantIssuer({ async connect() { connections++; throw new Error('DB'); }, query() {} },
    { auditRepository: { appendWithClient() {} }, expectedOfflineRole: 'cm_offline_owner' });
  for (const change of [{ operatorId: 'invalid' }, { kind: 'additional' }, { issuedFromSessionId: ID },
    { roles: ['platform_security_admin'] }, { tokenHash: 'a'.repeat(64) }, { environment: 'demo' },
    { providerIdentity: { ...request().providerIdentity, subjectReference: 'owner@example.com' } },
    { approvalReference: 'owner@example.com' }, { ttlSeconds: 901 }]) {
    await assert.rejects(issuer.issueOffline({ ...request(), ...change }), /PLATFORM_PASSKEY_/);
  }
  assert.equal(connections, 0);
});

test('actual authenticated role, effective role and catalog owner must all match the configured offline owner', async () => {
  for (const change of [{ active_role: 'cm_runtime' }, { authenticated_role: 'cm_runtime' }, { owner_role: 'cm_runtime' }]) {
    const calls = []; let released = false;
    const client = { async query(value) {
      calls.push(typeof value === 'string' ? value : value.name);
      if (typeof value === 'string') return { rows: [] };
      assert.equal(value.name, 'platform-passkey-offline-catalog-authority');
      return { rows: [{ active_role: 'cm_offline_owner', authenticated_role: 'cm_offline_owner',
        owner_role: 'cm_offline_owner', ...change }] };
    }, release() { released = true; } };
    const issuer = createPostgresPlatformPasskeyGrantIssuer({ async connect() { return client; }, query() {} },
      { auditRepository: { appendWithClient() { throw new Error('unexpected audit'); } }, expectedOfflineRole: 'cm_offline_owner' });
    await assert.rejects(issuer.issueOffline(request()), /OFFLINE_ISSUANCE_REJECTED/);
    assert.equal(released, true);
    assert.equal(calls.includes('ROLLBACK'), true);
    assert.equal(calls.includes('COMMIT'), false);
    assert.equal(calls.includes('platform-passkey-offline-operator-lock'), false);
  }
});

test('offline owner is a closed audit-only marker and cannot become session or business assurance', () => {
  const event = { operatorId: null, roles: [], permissions: [], assuranceLevel: 'offline_owner', targetTenantId: null,
    action: 'platform.operator.changed', targetType: 'platform_passkey_grant', targetId: ID,
    previousState: null, newState: null, occurredAt: new Date().toISOString(), correlationId: ID,
    outcome: 'success', metadata: { operation: 'passkey_grant_issued', approvalReference: 'CM-INT-OWNER-001' },
    retentionClass: 'recovery' };
  assert.equal(normalizePlatformAuditEvent(event).assuranceLevel, 'offline_owner');
  for (const change of [{ roles: ['platform_security_admin'] }, { targetTenantId: ID }, { outcome: 'failure' },
    { action: 'platform.authentication.succeeded' }, { targetType: 'platform_identity' }, { targetId: 'unmapped' },
    { retentionClass: 'security' }, { metadata: { token: 'forbidden' } }]) {
    assert.throws(() => normalizePlatformAuditEvent({ ...event, ...change }), /PLATFORM_AUDIT_/);
  }
  assert.throws(() => normalizeTrustedPlatformIdentity({ operatorId: ID, roles: ['platform_security_admin'],
    permissions: permissionsForPlatformRoles(['platform_security_admin']),
    securityVersion: 1, providerIdentity: request().providerIdentity, targetScope: { mode: 'all', securityVersion: 1 },
    assurance: { level: 'offline_owner', authenticationContext: 'offline', authenticatedAt: event.occurredAt } }),
  /PLATFORM_ASSURANCE_INVALID/);
});

test('runtime, HTTP and both Demo graphs reject transitive offline issuer access', () => {
  for (const root of ['src/platform-composition.js', 'src/platform/http/enroll.js', 'src/http/enroll.js',
    'src/demo/customer-composition.js', 'src/demo/platform-composition.js']) {
    const relative = root === 'src/platform-composition.js' ? './integrations/offline.js'
      : root === 'src/platform/http/enroll.js' ? '../../integrations/offline.js' : '../integrations/offline.js';
    const violations = architectureConsolidationBoundaryViolations({ [root]: `import '${relative}';`,
      'src/integrations/offline.js': "import '../persistence/postgres/platform-passkey-grant-issuer.js';",
      'src/persistence/postgres/platform-passkey-grant-issuer.js': 'export const issuer = true;' });
    assert.ok(violations.some(value => value.includes('must not reach offline passkey issuance')));
  }
});
