import { withPostgresTransaction } from './transaction.js';

const SESSION_TENANT_STATUSES = ['pending', 'onboarding', 'ready', 'active'];

function mapSessionRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    providerIdentity: Object.freeze({
      provider: row.provider,
      reference: row.provider_identity_reference,
    }),
    roles: Object.freeze([...row.roles]),
    permissions: Object.freeze([...row.permissions]),
    securityVersion: Number(row.principal_version),
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    tenantStatus: row.tenant_status,
  });
}

async function loadSecurityContext(client, tenantId, userId, expectedSecurityVersion) {
  const result = await client.query({
    name: 'session-security-context',
    text: `
      SELECT u.security_version, t.status AS tenant_status
      FROM users u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE u.tenant_id = $1
        AND u.id = $2
        AND u.active = true
        AND u.security_version = $3
        AND t.status = ANY($4::text[])
      FOR SHARE OF u, t
    `,
    values: [tenantId, userId, expectedSecurityVersion, SESSION_TENANT_STATUSES],
  });
  return result.rows[0] || null;
}

async function insertSession(client, session, securityContext) {
  const result = await client.query({
    name: 'session-insert',
    text: `
      INSERT INTO sessions (
        id,
        tenant_id,
        user_id,
        token_hash,
        provider,
        provider_identity_reference,
        roles,
        permissions,
        principal_version,
        issued_at,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9, $10, $11)
      RETURNING id, tenant_id, user_id, token_hash, provider, provider_identity_reference,
        roles, permissions, principal_version, issued_at, expires_at
    `,
    values: [
      session.id,
      session.tenantId,
      session.userId,
      session.tokenHash,
      session.providerIdentity.provider,
      session.providerIdentity.reference,
      session.roles,
      session.permissions,
      securityContext.security_version,
      session.issuedAt,
      session.expiresAt,
    ],
  });
  return mapSessionRow({ ...result.rows[0], tenant_status: securityContext.tenant_status });
}

async function appendAudit(client, auditRepository, auditEvent) {
  const stored = await auditRepository.appendWithClient(client, auditEvent);
  if (!stored) throw new Error('AUDIT_APPEND_FAILED');
}

export function createPostgresSessionRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async issue(session, auditEvent) {
      return withPostgresTransaction(pool, async (client) => {
        const securityContext = await loadSecurityContext(
          client,
          session.tenantId,
          session.userId,
          session.expectedSecurityVersion,
        );
        if (!securityContext) return null;
        const created = await insertSession(client, session, securityContext);
        await appendAudit(client, auditRepository, auditEvent);
        return created;
      });
    },

    async resolveByTokenHash(tokenHash, now) {
      const result = await pool.query({
        name: 'session-resolve-by-token-hash',
        text: `
          SELECT s.id, s.tenant_id, s.user_id, s.token_hash, s.provider,
            s.provider_identity_reference, s.roles, s.permissions, s.principal_version,
            s.issued_at, s.expires_at, t.status AS tenant_status
          FROM sessions s
          JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
          JOIN tenants t ON t.id = s.tenant_id
          WHERE s.token_hash = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > $2
            AND u.active = true
            AND u.security_version = s.principal_version
            AND t.status = ANY($3::text[])
          LIMIT 1
        `,
        values: [tokenHash, now, SESSION_TENANT_STATUSES],
      });
      return mapSessionRow(result.rows[0]);
    },

    async revoke({ sessionId, tenantId, userId, revokedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'session-revoke',
          text: `
            UPDATE sessions
            SET revoked_at = $4
            WHERE id = $1
              AND tenant_id = $2
              AND user_id = $3
              AND revoked_at IS NULL
            RETURNING id
          `,
          values: [sessionId, tenantId, userId, revokedAt],
        });
        if (result.rowCount !== 1) return false;
        await appendAudit(client, auditRepository, auditEvent);
        return true;
      });
    },

    async rotate({ currentSessionId, session, revokedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const current = await client.query({
          name: 'session-rotate-current',
          text: `
            SELECT id
            FROM sessions
            WHERE id = $1
              AND tenant_id = $2
              AND user_id = $3
              AND revoked_at IS NULL
              AND expires_at > $4
            FOR UPDATE
          `,
          values: [currentSessionId, session.tenantId, session.userId, revokedAt],
        });
        if (current.rowCount !== 1) return null;

        const securityContext = await loadSecurityContext(
          client,
          session.tenantId,
          session.userId,
          session.expectedSecurityVersion,
        );
        if (!securityContext) return null;
        const created = await insertSession(client, session, securityContext);
        await client.query({
          name: 'session-rotate-revoke-old',
          text: 'UPDATE sessions SET revoked_at = $2 WHERE id = $1',
          values: [currentSessionId, revokedAt],
        });
        await appendAudit(client, auditRepository, auditEvent);
        return created;
      });
    },
  });
}
