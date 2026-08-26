import { normalizeRequest } from '../../domain/request.js';
import { withPostgresTransaction } from './transaction.js';

const REQUEST_COLUMNS = `
  tenant_id,
  id,
  requester_user_id,
  room_id,
  status,
  status_reason,
  starts_at,
  ends_at,
  internal_participants,
  external_participants,
  status_changed_at,
  created_at,
  updated_at
`;

function mapRequestRow(row) {
  if (!row) return null;
  return normalizeRequest({
    tenantId: row.tenant_id,
    id: row.id,
    requesterUserId: row.requester_user_id,
    roomId: row.room_id,
    status: row.status,
    statusReason: row.status_reason,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    internalParticipants: row.internal_participants,
    externalParticipants: row.external_participants,
    statusChangedAt: row.status_changed_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

async function appendAudit(client, auditRepository, auditEvent) {
  const audit = await auditRepository.appendWithClient(client, auditEvent);
  if (!audit) throw new Error('AUDIT_APPEND_FAILED');
}

async function lockFinalRoom(client, tenantId, roomId) {
  await client.query({
    name: 'request-final-room-lock',
    text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    values: [`final-room-confirmation:${tenantId}:${roomId}`],
  });
}

export function createPostgresRequestRepository(
  pool,
  { auditRepository, calendarAuthorityGuard } = {},
) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }
  if (!calendarAuthorityGuard || typeof calendarAuthorityGuard.lockCurrent !== 'function') {
    throw new TypeError('CALENDAR_AUTHORITY_GUARD_REQUIRED');
  }

  return Object.freeze({
    async findByTenantIdAndId(tenantId, requestId) {
      const result = await pool.query({
        name: 'request-find-by-tenant-and-id',
        text: `
          SELECT ${REQUEST_COLUMNS}
          FROM requests
          WHERE tenant_id = $1
            AND id = $2
          LIMIT 1
        `,
        values: [tenantId, requestId],
      });
      return mapRequestRow(result.rows[0]);
    },

    async listByTenantId(tenantId, { requesterUserId = null, limit = 500 } = {}) {
      const result = await pool.query({
        name: 'request-list-by-tenant',
        text: `
          SELECT ${REQUEST_COLUMNS}
          FROM requests
          WHERE tenant_id = $1
            AND ($2::uuid IS NULL OR requester_user_id = $2::uuid)
          ORDER BY starts_at DESC, id
          LIMIT $3
        `,
        values: [tenantId, requesterUserId, limit],
      });
      return result.rows.map(mapRequestRow);
    },

    async createForTenant({
      tenantId,
      requestId,
      requesterUserId,
      roomId,
      startsAt,
      endsAt,
      internalParticipants,
      externalParticipants,
      createdAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'request-create-for-tenant',
          text: `
            INSERT INTO requests (
              tenant_id, id, requester_user_id, room_id, status,
              starts_at, ends_at, internal_participants, external_participants,
              status_changed_at, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, 'Submitted', $5, $6, $7, $8, $9, $9, $9)
            RETURNING ${REQUEST_COLUMNS}
          `,
          values: [
            tenantId,
            requestId,
            requesterUserId,
            roomId,
            startsAt,
            endsAt,
            internalParticipants,
            externalParticipants,
            createdAt,
          ],
        });
        const request = mapRequestRow(result.rows[0]);
        await appendAudit(client, auditRepository, auditEvent);
        return request;
      });
    },

    async transitionByTenantIdAndId({
      tenantId,
      requestId,
      expectedStatus,
      nextStatus,
      reason,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'request-transition-by-tenant-and-id',
          text: `
            UPDATE requests
            SET status = $4,
              status_reason = $5,
              status_changed_at = $6,
              updated_at = $6
            WHERE tenant_id = $1
              AND id = $2
              AND status = $3
            RETURNING ${REQUEST_COLUMNS}
          `,
          values: [tenantId, requestId, expectedStatus, nextStatus, reason, changedAt],
        });
        const request = mapRequestRow(result.rows[0]);
        if (!request) return null;
        await appendAudit(client, auditRepository, auditEvent);
        return request;
      });
    },

    async confirmIfRoomAvailable({
      tenantId,
      requestId,
      expectedStatus,
      calendarAuthority,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        const locked = await client.query({
          name: 'request-final-confirm-lock-request',
          text: `
            SELECT ${REQUEST_COLUMNS}
            FROM requests
            WHERE tenant_id = $1 AND id = $2
            FOR UPDATE
          `,
          values: [tenantId, requestId],
        });
        const current = mapRequestRow(locked.rows[0]);
        if (!current || current.status !== expectedStatus || !current.roomId) {
          return Object.freeze({ status: 'state_conflict', request: current });
        }

        if (!await calendarAuthorityGuard.lockCurrent(
          client,
          { tenantId, requestId, authority: calendarAuthority },
        )) {
          return Object.freeze({ status: 'provider_authority_conflict', request: current });
        }

        await lockFinalRoom(client, tenantId, current.roomId);
        const conflict = await client.query({
          name: 'request-final-confirm-room-conflict',
          text: `
            SELECT 1
            FROM requests
            WHERE tenant_id = $1
              AND room_id = $2
              AND id <> $3
              AND status = 'Confirmed'
              AND starts_at < $5
              AND ends_at > $4
            LIMIT 1
          `,
          values: [tenantId, current.roomId, requestId, current.startsAt, current.endsAt],
        });
        if (conflict.rowCount > 0) {
          return Object.freeze({ status: 'room_conflict', request: current });
        }

        const result = await client.query({
          name: 'request-final-confirm-update',
          text: `
            UPDATE requests
            SET status = 'Confirmed',
                status_reason = NULL,
                status_changed_at = $4,
                updated_at = $4
            WHERE tenant_id = $1
              AND id = $2
              AND status = $3
            RETURNING ${REQUEST_COLUMNS}
          `,
          values: [tenantId, requestId, expectedStatus, changedAt],
        });
        const confirmed = mapRequestRow(result.rows[0]);
        if (!confirmed) return Object.freeze({ status: 'state_conflict', request: current });
        await appendAudit(client, auditRepository, auditEvent);
        return Object.freeze({ status: 'confirmed', request: confirmed });
      });
    },
  });
}
