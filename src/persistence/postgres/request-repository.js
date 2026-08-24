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

export function createPostgresRequestRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
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
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return request;
      });
    },
  });
}
