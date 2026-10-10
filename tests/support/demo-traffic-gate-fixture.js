import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { PLATFORM_ROLE, permissionsForPlatformRoles } from '../../src/platform/identity/policy.js';
import * as customerSecurity from '../../src/security.js';
import * as platformSecurity from '../../src/platform/http/security.js';
import { demoMediaStorageEnvironment, demoMediaStorageConfig } from './demo-media-storage-environment.js';

export const NOW = Date.parse('2026-10-10T13:00:00.000Z');
export function trafficFixture(surface = 'customer', mode = 'acceptance', overrides = {}) {
  const token = randomBytes(32).toString('hex');
  const env = demoMediaStorageEnvironment(surface, 'neon', {
    DEMO_TRAFFIC_MODE: mode,
    ...(mode === 'acceptance' ? {
      [`DEMO_${surface.toUpperCase()}_ACCEPTANCE_TOKEN`]: token,
      DEMO_TRAFFIC_ACCEPTANCE_EXPIRES_AT: new Date(NOW + 60_000).toISOString(),
    } : {}),
    ...overrides,
  });
  const boundary = surface === 'customer' ? {
    ...customerSecurity, assertRequestTarget: customerSecurity.assertSafeRequestTarget,
    assertRequestOrigin: customerSecurity.assertSameOrigin,
  } : {
    applySecurityHeaders: platformSecurity.applyPlatformSecurityHeaders,
    assertRequestHost: platformSecurity.assertPlatformRequestHost,
    assertRequestTarget: platformSecurity.assertPlatformRequestTarget,
    assertRequestOrigin: platformSecurity.assertPlatformRequestOrigin,
    createRequestId: platformSecurity.createPlatformRequestId,
  };
  return { env, config: demoMediaStorageConfig(env, surface), surface, boundary, token };
}

export async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

export function request(port, surface, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { host: `${surface}.demo.invalid`, ...headers }, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
    req.end(headers['content-length'] === '1' ? 'x' : undefined);
  });
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function authenticatedPrincipal(surface) {
  const id = '11111111-1111-4111-8111-111111111111';
  const issuedAt = new Date(NOW).toISOString();
  const expiresAt = new Date(NOW + 60_000).toISOString();
  const session = { id, issuedAt, expiresAt, securityVersion: 1 };
  if (surface === 'customer') return { userId: id, tenantId: id,
    providerIdentity: { provider: 'demo', reference: 'synthetic-subject' },
    roles: ['employee'], permissions: ['request:read'], session };
  const roles = [PLATFORM_ROLE.TENANT_OPERATOR];
  return { operatorId: id, roles, permissions: permissionsForPlatformRoles(roles), securityVersion: 1,
    providerIdentity: { provider: 'demo', tenantReference: id, subjectReference: id },
    targetScope: { mode: 'allowlist', securityVersion: 1 },
    assurance: { level: 'mfa', authenticationContext: 'synthetic-mfa', authenticatedAt: issuedAt },
    session: { ...session, securityEpoch: 1, stepUpExpiresAt: null } };
}
