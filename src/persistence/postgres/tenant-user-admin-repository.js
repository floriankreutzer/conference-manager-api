import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const ELEVATED_ROLE_ORDER = Object.freeze(['conference_manager', 'tenant_admin']);
const ELEVATED_ROLES = new Set(ELEVATED_ROLE_ORDER);

function assertUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
}

function assertDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('TENANT_USER_CHANGED_AT_INVALID');
  }
}

function normalizeElevatedRoles(value) {
  if (!Array.isArray(value) || value.length > ELEVATED_ROLE_ORDER.length) {
    throw new TypeError('TENANT_USER_ROLES_INVALID');
  }
  if (new Set(value).size !== value.length || value.some((role) => !ELEVATED_ROLES.has(role))) {
    throw new TypeError('TENANT_USER_ROLES_INVALID');
  }
  return Object.freeze(ELEVATED_ROLE_ORDER.filter((role) => value.includes(role)));
}

function mapUser(row, elevatedRoles) {
  if (!row) return null;
  return Object.freeze({
    tenantId: row.tenant_id,
    userId: row.id,
    displayName: row.display_name,
    active: row.active,
    securityVersion: Number(row.security_version),
    elevatedRoles: normalizeElevatedRoles(elevatedRoles || []),
  });
}

function sameRoles(left, right) {
  return left.length === right.length && left.every((role, index) => role === right[index]);
}

async function loadElevatedRoles(client, tenantId, userId) {
  const result = await client.query({
    name: 'tenant-user-load-elevated-roles',
    text: `
      SELECT role
      FROM tenant_user_roles
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY CASE role
        WHEN 'conference_manager' THEN 1
        WHEN 'tenant_admin' THEN 2
        ELSE 99
      END
    `,
    values: [tenantId, userId],
  });
  return normalizeElevatedRoles(result.rows.map((row) => row.role));
}

export function createPostgresTenantUserAdminRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async listByTenantId({ tenantId, limit = 100, afterUserId = null } = {}) {
      assertUuid(tenantId, 'TENANT_USER_TENANT_ID_INVALID');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError('TENANT_USER_LIMIT_INVALID');
      }
      if (afterUserId !== null) assertUuid(afterUserId, 'TENANT_USER_CURSOR_INVALID');
      const result = await pool.query({
        name: 'tenant-user-list',
        text: `
          SELECT
            u.tenant_id,
            u.id,
            u.display_name,
            u.active,
            u.security_version,
            COALESCE(
              array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL),
              ARRAY[]::varchar[]
            ) AS elevated_roles
          FROM users u
          LEFT JOIN tenant_user_roles r
            ON r.tenant_id = u.tenant_id
           AND r.user_id = u.id
          WHERE u.tenant_id = $1
            AND ($2::uuid IS NULL OR u.id::text > $2::uuid::text)
          GROUP BY u.tenant_id, u.id, u.display_name, u.active, u.security_version
          ORDER BY u.id::text
          LIMIT $3
        `,
        values: [tenantId, afterUserId, limit],
      });
      return Object.freeze(result.rows.map((row) => mapUser(row, row.elevated_roles)));
    },

    async setElevatedRoles({
      tenantId,
      targetUserId,
      elevatedRoles,
      changedAt,
      auditEventFor,
    }) {
      assertUuid(tenantId, 'TENANT_USER_TENANT_ID_INVALID');
      assertUuid(targetUserId, 'TENANT_USER_ID_INVALID');
      const desiredRoles = normalizeElevatedRoles(elevatedRoles);
      assertDate(changedAt);
      if (typeof auditEventFor !== 'function') throw new TypeError('TENANT_USER_AUDIT_FACTORY_REQUIRED');

      return withPostgresTransaction(pool, async (client) => {
        await client.query({
          name: 'tenant-user-role-admin-lock',
          text: 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          values: [`tenant-role-admin:${tenantId}`],
        });
        const target = await client.query({
          name: 'tenant-user-role-lock-target',
          text: `
            SELECT tenant_id, id, display_name, active, security_version
            FROM users
            WHERE tenant_id = $1 AND id = $2
            FOR UPDATE
          `,
          values: [tenantId, targetUserId],
        });
        const user = target.rows[0];
        if (!user) return Object.freeze({ status: 'not_found' });

        const currentRoles = await loadElevatedRoles(client, tenantId, targetUserId);
        if (sameRoles(currentRoles, desiredRoles)) {
          return Object.freeze({ status: 'unchanged', user: mapUser(user, currentRoles) });
        }
        if (user.active !== true && desiredRoles.length > 0) {
          return Object.freeze({ status: 'user_inactive' });
        }

        const removesTenantAdmin = currentRoles.includes('tenant_admin') && !desiredRoles.includes('tenant_admin');
        if (removesTenantAdmin) {
          const viableAdmins = await client.query({
            name: 'tenant-user-count-other-viable-admins',
            text: `
              SELECT count(*)::int AS count
              FROM tenant_user_roles r
              JOIN users u
                ON u.tenant_id = r.tenant_id
               AND u.id = r.user_id
              WHERE r.tenant_id = $1
                AND r.role = 'tenant_admin'
                AND r.user_id <> $2
                AND u.active = true
            `,
            values: [tenantId, targetUserId],
          });
          if (viableAdmins.rows[0]?.count === 0) {
            return Object.freeze({ status: 'last_tenant_admin' });
          }
        }

        await client.query({
          name: 'tenant-user-delete-elevated-roles',
          text: 'DELETE FROM tenant_user_roles WHERE tenant_id = $1 AND user_id = $2',
          values: [tenantId, targetUserId],
        });
        for (const role of desiredRoles) {
          await client.query({
            name: 'tenant-user-insert-elevated-role',
            text: `
              INSERT INTO tenant_user_roles (tenant_id, user_id, role, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $4)
            `,
            values: [tenantId, targetUserId, role, changedAt],
          });
        }
        const updated = await client.query({
          name: 'tenant-user-invalidate-privilege-sessions',
          text: `
            UPDATE users
            SET security_version = security_version + 1,
                updated_at = $3
            WHERE tenant_id = $1 AND id = $2
            RETURNING tenant_id, id, display_name, active, security_version
          `,
          values: [tenantId, targetUserId, changedAt],
        });
        if (updated.rowCount !== 1) throw new Error('TENANT_USER_SECURITY_VERSION_UPDATE_FAILED');
        const auditEvent = auditEventFor({
          previousElevatedRoles: currentRoles,
          nextElevatedRoles: desiredRoles,
        });
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({
          status: 'updated',
          user: mapUser(updated.rows[0], desiredRoles),
        });
      });
    },
  });
}
