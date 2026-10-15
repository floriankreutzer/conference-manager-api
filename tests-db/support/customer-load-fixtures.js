import { randomBytes, randomUUID } from 'node:crypto';
import { tenantAuthorizationSnapshot, TENANT_ROLE } from '../../src/authorization/policy.js';
import { createSessionService } from '../../src/identity/session-service.js';

export function instrumentLoadPool(pool) {
  const clients = new Set();
  let queries = 0;
  pool.on('connect', (client) => {
    clients.add(client);
    const query = client.query;
    client.query = function (...args) { queries += 1; return query.apply(this, args); };
  });
  return () => ({ queries, bytesRead: [...clients].reduce((sum, c) => sum + c.connection.stream.bytesRead, 0),
    bytesWritten: [...clients].reduce((sum, c) => sum + c.connection.stream.bytesWritten, 0) });
}

export async function seedLoadSessions(pool, tenants, fixtures, target, { roles = Object.values(TENANT_ROLE) } = {}) {
  const records = [];
  if (!Array.isArray(roles) || roles.length < 1 || roles.length > 3 || new Set(roles).size !== roles.length
    || roles.some(role => !Object.values(TENANT_ROLE).includes(role))) throw new Error('LOAD_FIXTURE_ROLES_INVALID');
  // Reuse canonical token generation/hash/security epoch without duplicating production crypto.
  // This repository captures generated fixture records; it does not simulate a provider login or its audit.
  const service = createSessionService({
    publicOrigin: 'http://127.0.0.1:3000', csrfSecret: randomBytes(32).toString('hex'),
    auditService: { createActorEvent() { return {}; }, createEvent() { return {}; }, async record() {} },
    repository: {
      async resolveByTokenHash() { throw new Error('FIXTURE_RESOLUTION_NOT_ALLOWED'); },
      async issue(record) { records.push(record); return { ...record, securityVersion: 1 }; },
    },
  });
  for (let index = fixtures.length; index < target; index += 1) {
    const identity = { tenantId: tenants[index % tenants.length], userId: randomUUID(), securityVersion: 1,
      providerIdentity: { provider: 'microsoft_entra', reference: `synthetic-${index}` },
      ...tenantAuthorizationSnapshot([roles[index % roles.length]]) };
    const result = await service.issue(identity);
    fixtures.push({ tenantId: identity.tenantId, userId: identity.userId,
      roles: identity.roles, cookie: result.setCookie.split(';', 1)[0] });
  }
  for (let offset = 0; offset < records.length; offset += 500) {
    const chunk = JSON.stringify(records.slice(offset, offset + 500));
    await pool.query(`INSERT INTO users (tenant_id, id, display_name)
      SELECT "tenantId", "userId", 'Synthetic load fixture'
      FROM jsonb_to_recordset($1::jsonb) AS fixture("tenantId" uuid, "userId" uuid)`, [chunk]);
    await pool.query(`INSERT INTO sessions (
      id, tenant_id, user_id, token_hash, provider, provider_identity_reference,
      roles, permissions, principal_version, issued_at, expires_at
    ) SELECT id, "tenantId", "userId", "tokenHash", "providerIdentity"->>'provider',
      "providerIdentity"->>'reference', ARRAY(SELECT jsonb_array_elements_text(roles)),
      ARRAY(SELECT jsonb_array_elements_text(permissions)), "expectedSecurityVersion", "issuedAt", "expiresAt"
      FROM jsonb_to_recordset($1::jsonb) AS fixture(id uuid, "tenantId" uuid, "userId" uuid,
        "tokenHash" text, "providerIdentity" jsonb, roles jsonb, permissions jsonb,
        "expectedSecurityVersion" bigint, "issuedAt" timestamptz, "expiresAt" timestamptz)`, [chunk]);
  }
}

