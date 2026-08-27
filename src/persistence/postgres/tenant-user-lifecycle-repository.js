import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const ELEVATED_ROLE_ORDER = Object.freeze(['conference_manager', 'tenant_admin']);
const ELEVATED_ROLES = new Set(ELEVATED_ROLE_ORDER);
const LIST_STATUS = new Set(['all', 'active', 'disabled']);
const LIST_ROLE = new Set(['all', 'employee_only', ...ELEVATED_ROLE_ORDER]);
const LIST_PROVIDER = new Set(['all', 'linked', 'unlinked']);

function requireUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
}

function requireDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('TENANT_USER_CHANGED_AT_INVALID');
  }
}

function normalizeRoles(value) {
  if (!Array.isArray(value) || value.length > ELEVATED_ROLE_ORDER.length) {
    throw new TypeError('TENANT_USER_ROLES_INVALID');
  }
  if (new Set(value).size !== value.length || value.some((role) => !ELEVATED_ROLES.has(role))) {
    throw new TypeError('TENANT_USER_ROLES_INVALID');
  }
  return Object.freeze(ELEVATED_ROLE_ORDER.filter((role) => value.includes(role)));
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : null;
}

function mapUser(row) {
  if (!row) return null;
  const lifecycleVersion = Number(row.lifecycle_revision);
  const openRequestCount = Number(row.open_request_count);
  if (!Number.isSafeInteger(lifecycleVersion) || !Number.isSafeInteger(openRequestCount)) {
    throw new TypeError('TENANT_USER_LIFECYCLE_ROW_INVALID');
  }
  return Object.freeze({
    tenantId: row.tenant_id,
    userId: row.id,
    displayName: row.display_name,
    active: row.active,
    securityVersion: Number(row.security_version),
    lifecycleVersion,
    elevatedRoles: normalizeRoles(row.elevated_roles || []),
    identityLinked: row.identity_linked === true,
    identityLinkedAt: iso(row.identity_linked_at),
    lastSignInAt: iso(row.last_sign_in_at),
    ownedOpenRequestCount: openRequestCount,
  });
}

const USER_PRESENTATION_COLUMNS = `
  u.tenant_id,
  u.id,
  u.display_name,
  u.active,
  u.security_version,
  u.lifecycle_revision,
  COALESCE(role_state.elevated_roles, ARRAY[]::varchar[]) AS elevated_roles,
  (identity_state.identity_linked_at IS NOT NULL) AS identity_linked,
  identity_state.identity_linked_at,
  session_state.last_sign_in_at,
  COALESCE(request_state.open_request_count, 0)::int AS open_request_count
`;

const USER_PRESENTATION_JOINS = `
  LEFT JOIN LATERAL (
    SELECT array_agg(role ORDER BY CASE role
      WHEN 'conference_manager' THEN 1
      WHEN 'tenant_admin' THEN 2
      ELSE 99
    END) AS elevated_roles
    FROM tenant_user_roles
    WHERE tenant_id = u.tenant_id AND user_id = u.id
  ) role_state ON true
  LEFT JOIN LATERAL (
    SELECT min(created_at) AS identity_linked_at
    FROM user_identity_bindings
    WHERE tenant_id = u.tenant_id AND user_id = u.id
  ) identity_state ON true
  LEFT JOIN LATERAL (
    SELECT max(issued_at) AS last_sign_in_at
    FROM sessions
    WHERE tenant_id = u.tenant_id AND user_id = u.id
  ) session_state ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS open_request_count
    FROM requests
    WHERE tenant_id = u.tenant_id
      AND requester_user_id = u.id
      AND status IN ('Submitted', 'In Review', 'Confirmed', 'Change Requested')
  ) request_state ON true
`;

async function loadUserState(client, tenantId, userId) {
  const result = await client.query({
    name: 'tenant-user-lifecycle-load-state',
    text: `
      SELECT ${USER_PRESENTATION_COLUMNS}
      FROM users u
      ${USER_PRESENTATION_JOINS}
      WHERE u.tenant_id = $1 AND u.id = $2
    `,
    values: [tenantId, userId],
  });
  return mapUser(result.rows[0]);
}

export function createPostgresTenantUserLifecycleRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async listByTenantId({
      tenantId,
      limit = 51,
      afterUserId = null,
      search = null,
      status = 'all',
      role = 'all',
      providerLink = 'all',
    } = {}) {
      requireUuid(tenantId, 'TENANT_USER_TENANT_ID_INVALID');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
        throw new TypeError('TENANT_USER_LIMIT_INVALID');
      }
      if (afterUserId !== null) requireUuid(afterUserId, 'TENANT_USER_CURSOR_INVALID');
      if (search !== null && (typeof search !== 'string' || search.length < 1 || search.length > 80)) {
        throw new TypeError('TENANT_USER_SEARCH_INVALID');
      }
      if (!LIST_STATUS.has(status) || !LIST_ROLE.has(role) || !LIST_PROVIDER.has(providerLink)) {
        throw new TypeError('TENANT_USER_FILTER_INVALID');
      }
      const result = await pool.query({
        name: 'tenant-user-lifecycle-list',
        text: `
          SELECT ${USER_PRESENTATION_COLUMNS}
          FROM users u
          ${USER_PRESENTATION_JOINS}
          WHERE u.tenant_id = $1
            AND ($2::uuid IS NULL OR u.id::text > $2::uuid::text)
            AND ($3::text IS NULL OR position(lower($3) in lower(u.display_name)) > 0)
            AND (
              $4::text = 'all'
              OR ($4 = 'active' AND u.active = true)
              OR ($4 = 'disabled' AND u.active = false)
            )
            AND (
              $5::text = 'all'
              OR ($5 = 'employee_only' AND cardinality(
                COALESCE(role_state.elevated_roles, ARRAY[]::varchar[])
              ) = 0)
              OR $5 = ANY(COALESCE(role_state.elevated_roles, ARRAY[]::varchar[]))
            )
            AND (
              $6::text = 'all'
              OR ($6 = 'linked' AND identity_state.identity_linked_at IS NOT NULL)
              OR ($6 = 'unlinked' AND identity_state.identity_linked_at IS NULL)
            )
          ORDER BY u.id::text
          LIMIT $7
        `,
        values: [tenantId, afterUserId, search, status, role, providerLink, limit],
      });
      return Object.freeze(result.rows.map(mapUser));
    },

    async changeAccess({
      tenantId,
      targetUserId,
      active,
      expectedVersion,
      changedAt,
      auditEventFor,
    }) {
      requireUuid(tenantId, 'TENANT_USER_TENANT_ID_INVALID');
      requireUuid(targetUserId, 'TENANT_USER_ID_INVALID');
      if (typeof active !== 'boolean' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new TypeError('TENANT_USER_LIFECYCLE_INPUT_INVALID');
      }
      requireDate(changedAt);
      if (typeof auditEventFor !== 'function') throw new TypeError('TENANT_USER_AUDIT_FACTORY_REQUIRED');

      return withPostgresTransaction(pool, async (client) => {
        await client.query({
          name: 'tenant-user-lifecycle-admin-lock',
          text: 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          values: [`tenant-role-admin:${tenantId}`],
        });
        const target = await client.query({
          name: 'tenant-user-lifecycle-lock-target',
          text: `
            SELECT tenant_id, id, active, security_version, lifecycle_revision
            FROM users
            WHERE tenant_id = $1 AND id = $2
            FOR UPDATE
          `,
          values: [tenantId, targetUserId],
        });
        const current = target.rows[0];
        if (!current) return Object.freeze({ status: 'not_found' });
        const currentVersion = Number(current.lifecycle_revision);
        if (currentVersion !== expectedVersion) {
          return Object.freeze({ status: 'version_conflict', currentVersion });
        }
        if (current.active === active) {
          return Object.freeze({
            status: 'unchanged',
            user: await loadUserState(client, tenantId, targetUserId),
          });
        }

        const roles = await client.query({
          name: 'tenant-user-lifecycle-load-roles',
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
          values: [tenantId, targetUserId],
        });
        const elevatedRoles = normalizeRoles(roles.rows.map((row) => row.role));
        if (!active && elevatedRoles.includes('tenant_admin')) {
          const viableAdmins = await client.query({
            name: 'tenant-user-lifecycle-count-other-admins',
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
            return Object.freeze({ status: 'last_tenant_admin', currentVersion });
          }
        }

        const openRequests = await client.query({
          name: 'tenant-user-lifecycle-count-open-requests',
          text: `
            SELECT count(*)::int AS count
            FROM requests
            WHERE tenant_id = $1
              AND requester_user_id = $2
              AND status IN ('Submitted', 'In Review', 'Confirmed', 'Change Requested')
          `,
          values: [tenantId, targetUserId],
        });
        const openRequestCount = Number(openRequests.rows[0]?.count || 0);
        const updated = await client.query({
          name: 'tenant-user-lifecycle-change-access',
          text: `
            UPDATE users
            SET active = $3,
                security_version = security_version + 1,
                lifecycle_revision = lifecycle_revision + 1,
                updated_at = $4
            WHERE tenant_id = $1
              AND id = $2
              AND lifecycle_revision = $5
            RETURNING lifecycle_revision
          `,
          values: [tenantId, targetUserId, active, changedAt, expectedVersion],
        });
        if (updated.rowCount !== 1) throw new Error('TENANT_USER_LIFECYCLE_UPDATE_FAILED');
        const nextVersion = Number(updated.rows[0].lifecycle_revision);
        const revoked = await client.query({
          name: 'tenant-user-lifecycle-revoke-sessions',
          text: `
            UPDATE sessions
            SET revoked_at = $3
            WHERE tenant_id = $1
              AND user_id = $2
              AND revoked_at IS NULL
          `,
          values: [tenantId, targetUserId, changedAt],
        });
        const auditEvent = auditEventFor({
          previousActive: current.active,
          nextActive: active,
          previousVersion: currentVersion,
          nextVersion,
          openRequestCount,
          revokedSessionCount: revoked.rowCount,
        });
        if (!await auditRepository.appendWithClient(client, auditEvent)) {
          throw new Error('AUDIT_APPEND_FAILED');
        }
        return Object.freeze({
          status: 'updated',
          user: await loadUserState(client, tenantId, targetUserId),
        });
      });
    },
  });
}
