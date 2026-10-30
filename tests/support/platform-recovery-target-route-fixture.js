import assert from 'node:assert/strict';
import { createPlatformAuthorizationPolicy } from '../../src/platform/identity/policy.js';

// Concrete route construction needs the full recovery port. These tests must
// never preview or execute a recovery while qualifying a sensitive target read.
export function recoveryTargetRouteService(onRead) {
  const service = Object.fromEntries([
    'previewLastTenantAdmin', 'recoverLastTenantAdmin',
    'previewMicrosoftReconsent', 'initiateMicrosoftReconsent',
    'previewRoomMappingRepair', 'repairRoomMapping',
    'previewIdentityUnbind', 'unbindTenantIdentity',
    'previewTenantSessionRevocation', 'revokeTenantSessions',
    'previewUserSessionRevocation', 'revokeUserSessions',
    'previewTenantSuspension', 'suspendTenant',
    'previewTenantReactivation', 'reactivateTenant',
  ].map(name => [name, async () => assert.fail(`Unexpected recovery operation: ${name}`)]));
  const policy = createPlatformAuthorizationPolicy();
  service.listRecoveryTargets = async input => {
    const permission = input.operation === 'user-session-revocation'
      ? 'platform:session:revoke' : 'platform:recovery:execute';
    assert.equal(policy.authorize(input.operatorContext, permission), true);
    return onRead(input);
  };
  return service;
}
