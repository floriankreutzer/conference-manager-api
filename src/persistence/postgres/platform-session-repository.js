import { withPostgresTransaction } from './transaction.js';

const SESSION_COLUMNS = `
  s.id,
  s.operator_id,
  s.provider,
  s.provider_tenant_reference,
  s.provider_subject_reference,
  s.roles,
  s.permissions,
  s.principal_version,
  s.scope_mode,
  s.security_epoch,
  s.assurance_level,
  s.authentication_context,
  s.authenticated_at,
  s.issued_at,
  s.expires_at,
  s.step_up_expires_at
`;

function instant(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapSession(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    operatorId: row.operator_id,
    providerIdentity: Object.freeze({
      provider: row.provider,
      tenantReference: row.provider_tenant_reference,
      subjectReference: row.provider_subject_reference,
    }),
    roles: Object.freeze([...row.roles]),
    permissions: Object.freeze([...row.permissions]),
    securityVersion: Number(row.principal_version),
    targetScope: Object.freeze({
      mode: row.scope_mode,
      securityVersion: Number(row.principal_version),
    }),
    securityEpoch: Number(row.security_epoch),
    assurance: Object.freeze({
      level: row.assurance_level,
      authenticationContext: row.authentication_context,
      authenticatedAt: instant(row.authenticated_at),
    }),
    issuedAt: instant(row.issued_at),
    expiresAt: instant(row.expires_at),
    stepUpExpiresAt: row.step_up_expires_at === null ? null : instant(row.step_up_expires_at),
  });
}

async function lockOperator(client, session) {
  const result = await client.query({
    name: 'platform-session-operator-lock',
    text: `
      SELECT id, roles, security_version, scope_mode
      FROM platform_operators
      WHERE id = $1
        AND status = 'active'
        AND provider = $2
        AND provider_tenant_reference = $3
        AND provider_subject_reference = $4
        AND security_version = $5
      FOR SHARE
    `,
    values: [
      session.operatorId,
      session.providerIdentity.provider,
      session.providerIdentity.tenantReference,
      session.providerIdentity.subjectReference,
      session.expectedSecurityVersion,
    ],
  });
  if (result.rowCount !== 1) return null;
  if (
    result.rows[0].roles.length !== session.roles.length
    || result.rows[0].roles.some((role, index) => role !== session.roles[index])
    || result.rows[0].scope_mode !== session.targetScope.mode
  ) return null;
  return result.rows[0];
}

async function insertSession(client, session) {
  const result = await client.query({
    name: 'platform-session-insert',
    text: `
      WITH database_time AS (SELECT clock_timestamp() AS issued_at)
      INSERT INTO platform_sessions (
        id, operator_id, token_hash, provider, provider_tenant_reference,
        provider_subject_reference, roles, permissions, principal_version,
        scope_mode, security_epoch, assurance_level, authentication_context, authenticated_at,
        issued_at, expires_at, step_up_expires_at
      )
      SELECT $1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9, $10, $11,
        $12, $13, $14, database_time.issued_at,
        database_time.issued_at + ($15::integer * INTERVAL '1 second'),
        CASE WHEN $12 = 'step_up' THEN LEAST(
          database_time.issued_at + ($15::integer * INTERVAL '1 second'),
          $14::timestamptz + ($16::integer * INTERVAL '1 second')
        ) ELSE NULL END
      FROM database_time
      RETURNING id, operator_id, provider, provider_tenant_reference,
        provider_subject_reference, roles, permissions, principal_version,
        scope_mode, security_epoch, assurance_level, authentication_context, authenticated_at,
        issued_at, expires_at, step_up_expires_at
    `,
    values: [
      session.id, session.operatorId, session.tokenHash, session.providerIdentity.provider,
      session.providerIdentity.tenantReference, session.providerIdentity.subjectReference,
      session.roles, session.permissions, session.expectedSecurityVersion, session.targetScope.mode,
      session.securityEpoch, session.assurance.level, session.assurance.authenticationContext,
      session.assurance.authenticatedAt, session.sessionTtlSeconds, session.stepUpTtlSeconds,
    ],
  });
  return mapSession(result.rows[0]);
}

async function appendEvents(client, auditRepository, eventValue) {
  const events = Array.isArray(eventValue) ? eventValue : [eventValue];
  if (events.length < 1 || events.length > 2) throw new TypeError('PLATFORM_SESSION_AUDIT_EVENTS_INVALID');
  for (const event of events) await auditRepository.appendWithClient(client, event);
}

export function createPostgresPlatformSessionRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async issue(session, eventFactory) {
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockOperator(client, session)) return null;
        const stored = await insertSession(client, session);
        await appendEvents(client, auditRepository, eventFactory(stored));
        return stored;
      });
    },

    async resolveByTokenHash(tokenHash, securityEpoch) {
      const result = await pool.query({
        name: 'platform-session-resolve',
        text: `
          SELECT ${SESSION_COLUMNS}
          FROM platform_sessions s
          JOIN platform_operators o ON o.id = s.operator_id
          WHERE s.token_hash = $1
            AND s.security_epoch = $2
            AND s.revoked_at IS NULL
            AND s.expires_at > clock_timestamp()
            AND o.status = 'active'
            AND o.security_version = s.principal_version
            AND o.roles = s.roles
            AND o.scope_mode = s.scope_mode
          LIMIT 1
        `,
        values: [tokenHash, securityEpoch],
      });
      return mapSession(result.rows[0]);
    },

    async revoke({ sessionId, operatorId, eventFactory }) {
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'platform-session-revoke',
          text: `
            UPDATE platform_sessions
            SET revoked_at = clock_timestamp()
            WHERE id = $1 AND operator_id = $2 AND revoked_at IS NULL
            RETURNING revoked_at
          `,
          values: [sessionId, operatorId],
        });
        if (result.rowCount !== 1) return false;
        await appendEvents(client, auditRepository, eventFactory(instant(result.rows[0].revoked_at)));
        return true;
      });
    },

    async rotate({ currentSessionId, session, eventFactory }) {
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockOperator(client, session)) return null;
        const current = await client.query({
          name: 'platform-session-rotate-current',
          text: `
            SELECT id
            FROM platform_sessions
            WHERE id = $1
              AND operator_id = $2
              AND revoked_at IS NULL
              AND expires_at > clock_timestamp()
            FOR UPDATE
          `,
          values: [currentSessionId, session.operatorId],
        });
        if (current.rowCount !== 1) return null;
        const stored = await insertSession(client, session);
        await client.query({
          name: 'platform-session-rotate-revoke-current',
          text: `
            UPDATE platform_sessions
            SET revoked_at = clock_timestamp(), replaced_by_session_id = $2
            WHERE id = $1
          `,
          values: [currentSessionId, stored.id],
        });
        await appendEvents(client, auditRepository, eventFactory(stored));
        return stored;
      });
    },

    async revokeAllForOperatorWithClient(client, operatorId) {
      const result = await client.query({
        name: 'platform-session-revoke-all-operator',
        text: `
          UPDATE platform_sessions
          SET revoked_at = clock_timestamp()
          WHERE operator_id = $1 AND revoked_at IS NULL
        `,
        values: [operatorId],
      });
      return result.rowCount;
    },
  });
}
