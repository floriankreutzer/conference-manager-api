import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TENANT_LOGIN_STATUSES = new Set(['onboarding', 'ready', 'active']);

function assertUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
}

function assertProvider(value) {
  if (typeof value !== 'string' || !PROVIDER_PATTERN.test(value)) throw new TypeError('JIT_PROVIDER_INVALID');
}

function assertReference(value, code) {
  if (typeof value !== 'string' || !REFERENCE_PATTERN.test(value)) throw new TypeError(code);
}

function assertDisplayName(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 160
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError('JIT_DISPLAY_NAME_INVALID');
  }
}

function assertDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('JIT_CHANGED_AT_INVALID');
}

function mapped(row, { created = false, profileChanged = false } = {}) {
  if (!row) return null;
  return Object.freeze({
    tenantId: row.tenant_id,
    userId: row.user_id,
    displayName: row.display_name,
    active: row.active,
    securityVersion: Number(row.security_version),
    created,
    profileChanged,
  });
}

export function createPostgresJitUserRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async resolveOrProvision({
      tenantId,
      provider,
      providerTenantReference,
      providerUserReference,
      displayName,
      newUserId,
      changedAt,
      provisionAuditEvent,
      profileAuditEventFor,
    }) {
      assertUuid(tenantId, 'JIT_TENANT_ID_INVALID');
      assertProvider(provider);
      assertReference(providerTenantReference, 'JIT_PROVIDER_TENANT_REFERENCE_INVALID');
      assertReference(providerUserReference, 'JIT_PROVIDER_USER_REFERENCE_INVALID');
      assertDisplayName(displayName);
      assertUuid(newUserId, 'JIT_USER_ID_INVALID');
      assertDate(changedAt);
      if (typeof profileAuditEventFor !== 'function') throw new TypeError('JIT_PROFILE_AUDIT_FACTORY_REQUIRED');

      return withPostgresTransaction(pool, async (client) => {
        await client.query({
          name: 'jit-lock-provider-user',
          text: 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          values: [`${tenantId}:${provider}:${providerTenantReference}:${providerUserReference}`],
        });

        const tenant = await client.query({
          name: 'jit-lock-tenant',
          text: 'SELECT status FROM tenants WHERE id = $1 FOR SHARE',
          values: [tenantId],
        });
        const tenantStatus = tenant.rows[0]?.status;
        if (!TENANT_LOGIN_STATUSES.has(tenantStatus)) return Object.freeze({ status: 'tenant_unavailable' });

        const existing = await client.query({
          name: 'jit-find-provider-user-binding',
          text: `
            SELECT
              b.tenant_id,
              b.user_id,
              u.display_name,
              u.active,
              u.security_version
            FROM user_identity_bindings b
            JOIN users u
              ON u.tenant_id = b.tenant_id
             AND u.id = b.user_id
            WHERE b.tenant_id = $1
              AND b.provider = $2
              AND b.provider_tenant_reference = $3
              AND b.provider_user_reference = $4
            FOR UPDATE OF b, u
          `,
          values: [tenantId, provider, providerTenantReference, providerUserReference],
        });
        const current = existing.rows[0];
        if (current) {
          if (current.active !== true) return Object.freeze({ status: 'user_disabled' });
          if (current.display_name !== displayName) {
            const updated = await client.query({
              name: 'jit-update-user-profile',
              text: `
                UPDATE users
                SET display_name = $3,
                    updated_at = $4
                WHERE tenant_id = $1
                  AND id = $2
                  AND active = true
                RETURNING tenant_id, id AS user_id, display_name, active, security_version
              `,
              values: [tenantId, current.user_id, displayName, changedAt],
            });
            if (updated.rowCount !== 1) return Object.freeze({ status: 'user_disabled' });
            const profileAuditEvent = profileAuditEventFor(current.user_id);
            const audit = await auditRepository.appendWithClient(client, profileAuditEvent);
            if (!audit) throw new Error('AUDIT_APPEND_FAILED');
            return Object.freeze({ status: 'resolved', identity: mapped(updated.rows[0], { profileChanged: true }) });
          }
          return Object.freeze({ status: 'resolved', identity: mapped(current) });
        }

        const insertedUser = await client.query({
          name: 'jit-create-employee-user',
          text: `
            INSERT INTO users (
              tenant_id, id, display_name, active, created_at, updated_at
            )
            VALUES ($1, $2, $3, true, $4, $4)
            RETURNING tenant_id, id AS user_id, display_name, active, security_version
          `,
          values: [tenantId, newUserId, displayName, changedAt],
        });
        if (insertedUser.rowCount !== 1) throw new Error('JIT_USER_CREATE_FAILED');
        await client.query({
          name: 'jit-create-provider-user-binding',
          text: `
            INSERT INTO user_identity_bindings (
              tenant_id,
              provider,
              provider_tenant_reference,
              provider_user_reference,
              user_id,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $6)
          `,
          values: [
            tenantId,
            provider,
            providerTenantReference,
            providerUserReference,
            newUserId,
            changedAt,
          ],
        });
        const audit = await auditRepository.appendWithClient(client, provisionAuditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({
          status: 'resolved',
          identity: mapped(insertedUser.rows[0], { created: true }),
        });
      });
    },
  });
}
