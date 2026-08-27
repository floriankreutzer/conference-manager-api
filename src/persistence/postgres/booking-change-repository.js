import { randomUUID } from 'node:crypto';
import { normalizeBookingChange } from '../../domain/booking-change.js';
import { normalizeRequest } from '../../domain/request.js';
import { BookingReferenceConflictError } from '../../integrations/errors.js';
import { withPostgresTransaction } from './transaction.js';

class BookingChangeStoreConflictError extends Error {}

const CHANGE_COLUMNS = `
  tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
  internal_participants, external_participants, base_request_updated_at,
  decided_by_user_id, rejection_reason, created_at, updated_at
`;

const REQUEST_COLUMNS = `
  tenant_id, id, requester_user_id, room_id, status, status_reason, starts_at, ends_at,
  internal_participants, external_participants, status_changed_at, created_at, updated_at
`;

function changeRow(row) {
  if (!row) return null;
  return normalizeBookingChange({
    tenantId: row.tenant_id,
    id: row.id,
    requestId: row.request_id,
    initiatorUserId: row.initiator_user_id,
    status: row.status,
    roomId: row.room_id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    internalParticipants: row.internal_participants,
    externalParticipants: row.external_participants,
    baseRequestUpdatedAt: row.base_request_updated_at.toISOString(),
    decidedByUserId: row.decided_by_user_id,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function requestRow(row) {
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
  const recorded = await auditRepository.appendWithClient(client, auditEvent);
  if (!recorded) throw new Error('AUDIT_APPEND_FAILED');
}

async function lockRequest(client, tenantId, requestId) {
  const result = await client.query({
    name: 'booking-change-lock-request',
    text: `SELECT ${REQUEST_COLUMNS} FROM requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    values: [tenantId, requestId],
  });
  return requestRow(result.rows[0]);
}

async function lockTenantLocationAuthority(client, tenantId) {
  const result = await client.query({
    name: 'booking-change-tenant-location-authority',
    text: 'SELECT 1 FROM tenants WHERE id = $1 FOR SHARE',
    values: [tenantId],
  });
  return result.rowCount === 1;
}

export function createPostgresBookingChangeRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async listAlternatives({ tenantId, requestId, startsAt, endsAt, participants }) {
      const result = await pool.query({
        name: 'booking-change-list-alternatives',
        text: `
          SELECT rm.id FROM rooms rm JOIN sites s ON s.tenant_id=rm.tenant_id AND s.id=rm.site_id
          WHERE rm.tenant_id=$1 AND rm.active=TRUE AND s.active=TRUE AND s.time_zone IS NOT NULL
            AND rm.capacity >= $2 AND NOT EXISTS (
              SELECT 1 FROM requests r WHERE r.tenant_id=rm.tenant_id AND r.room_id=rm.id
                AND r.id<>$3 AND r.status='Confirmed' AND r.starts_at<$5 AND r.ends_at>$4
            ) ORDER BY rm.capacity, rm.id LIMIT 5
        `,
        values: [tenantId, participants, requestId, startsAt, endsAt],
      });
      return Object.freeze(result.rows.map((row) => row.id));
    },

    async findOpen(tenantId, requestId) {
      const result = await pool.query({
        name: 'booking-change-find-open',
        text: `
          SELECT ${CHANGE_COLUMNS} FROM booking_change_requests
          WHERE tenant_id = $1 AND request_id = $2 AND status IN ('pending', 'applying')
          LIMIT 1
        `,
        values: [tenantId, requestId],
      });
      return changeRow(result.rows[0]);
    },

    async propose({ tenantId, requestId, changeId, initiatorUserId, proposal, changedAt, auditEvent }) {
      try {
        return await withPostgresTransaction(pool, async (client) => {
          const request = await lockRequest(client, tenantId, requestId);
          if (!request || request.status !== 'Confirmed') return Object.freeze({ status: 'conflict' });
          const room = await client.query({
            name: 'booking-change-lock-target-room',
            text: `
              SELECT rooms.capacity FROM rooms
              JOIN sites ON sites.tenant_id = rooms.tenant_id AND sites.id = rooms.site_id
              WHERE rooms.tenant_id = $1 AND rooms.id = $2
                AND rooms.active = TRUE AND sites.active = TRUE AND sites.time_zone IS NOT NULL
              FOR SHARE OF rooms, sites
            `,
            values: [tenantId, proposal.roomId],
          });
          if (!room.rows[0] || room.rows[0].capacity < proposal.internalParticipants + proposal.externalParticipants) {
            return Object.freeze({ status: 'capacity_conflict' });
          }
          const participantOnly = proposal.roomId === request.roomId
            && proposal.startsAt.toISOString() === request.startsAt
            && proposal.endsAt.toISOString() === request.endsAt;
          const status = participantOnly ? 'applied' : 'pending';
          const inserted = await client.query({
            name: 'booking-change-insert',
            text: `
              INSERT INTO booking_change_requests (
                tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
                internal_participants, external_participants, base_request_updated_at,
                decided_by_user_id, rejection_reason, created_at, updated_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL,$12,$12)
              RETURNING ${CHANGE_COLUMNS}
            `,
            values: [
              tenantId, changeId, requestId, initiatorUserId, status, proposal.roomId,
              proposal.startsAt, proposal.endsAt, proposal.internalParticipants,
              proposal.externalParticipants, new Date(request.updatedAt), changedAt,
            ],
          });
          let updatedRequest = request;
          if (participantOnly) {
            const updated = await client.query({
              name: 'booking-change-apply-participants',
              text: `
                UPDATE requests SET internal_participants = $3, external_participants = $4, updated_at = $5
                WHERE tenant_id = $1 AND id = $2 AND status = 'Confirmed' AND updated_at = $6
                RETURNING ${REQUEST_COLUMNS}
              `,
              values: [tenantId, requestId, proposal.internalParticipants,
                proposal.externalParticipants, changedAt, new Date(request.updatedAt)],
            });
            updatedRequest = requestRow(updated.rows[0]);
            if (!updatedRequest) throw new BookingChangeStoreConflictError();
            await client.query({
              name: 'booking-change-notify-requester-direct',
              text: 'INSERT INTO notifications (tenant_id, id, user_id, kind, created_at) VALUES ($1,$2,$3,$4,$5)',
              values: [tenantId, randomUUID(), request.requesterUserId, 'booking_change_applied', changedAt],
            });
          }
          await appendAudit(client, auditRepository, auditEvent);
          return Object.freeze({ status, change: changeRow(inserted.rows[0]), request: updatedRequest });
        });
      } catch (error) {
        if (error instanceof BookingChangeStoreConflictError) return Object.freeze({ status: 'conflict' });
        if (error?.code === '23505') return Object.freeze({ status: 'open_exists' });
        throw error;
      }
    },

    async beginApproval({ tenantId, requestId, changeId, deciderUserId, changedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockTenantLocationAuthority(client, tenantId)) {
          return Object.freeze({ status: 'conflict' });
        }
        const request = await lockRequest(client, tenantId, requestId);
        const locked = await client.query({
          name: 'booking-change-lock-pending',
          text: `SELECT ${CHANGE_COLUMNS} FROM booking_change_requests
            WHERE tenant_id = $1 AND request_id = $2 AND id = $3 FOR UPDATE`,
          values: [tenantId, requestId, changeId],
        });
        const change = changeRow(locked.rows[0]);
        if (!request || !change || change.status !== 'pending' || request.status !== 'Confirmed'
          || request.updatedAt !== change.baseRequestUpdatedAt) return Object.freeze({ status: 'conflict' });
        const total = change.internalParticipants + change.externalParticipants;
        const conflict = await client.query({
          name: 'booking-change-target-conflict',
          text: `
            SELECT 1 FROM requests r
            JOIN rooms rm ON rm.tenant_id = r.tenant_id AND rm.id = $2
            JOIN sites s ON s.tenant_id = rm.tenant_id AND s.id = rm.site_id
            WHERE r.tenant_id = $1 AND r.id <> $3 AND r.room_id = $2 AND r.status = 'Confirmed'
              AND r.starts_at < $5 AND r.ends_at > $4
              AND rm.active = TRUE AND s.active = TRUE AND s.time_zone IS NOT NULL
              AND rm.capacity >= $6 LIMIT 1
          `,
          values: [tenantId, change.roomId, requestId, change.startsAt, change.endsAt, total],
        });
        const target = await client.query({
          name: 'booking-change-target-valid',
          text: `SELECT 1 FROM rooms rm JOIN sites s ON s.tenant_id=rm.tenant_id AND s.id=rm.site_id
            WHERE rm.tenant_id=$1 AND rm.id=$2 AND rm.active=TRUE AND s.active=TRUE
              AND s.time_zone IS NOT NULL AND rm.capacity >= $3
            FOR SHARE OF rm, s`,
          values: [tenantId, change.roomId, total],
        });
        if (conflict.rowCount || !target.rowCount) {
          const alternatives = await client.query({
            name: 'booking-change-alternatives',
            text: `
              SELECT rm.id FROM rooms rm JOIN sites s ON s.tenant_id=rm.tenant_id AND s.id=rm.site_id
              WHERE rm.tenant_id=$1 AND rm.active=TRUE AND s.active=TRUE AND s.time_zone IS NOT NULL
                AND rm.capacity >= $2 AND NOT EXISTS (
                  SELECT 1 FROM requests r WHERE r.tenant_id=rm.tenant_id AND r.room_id=rm.id
                    AND r.id<>$3 AND r.status='Confirmed' AND r.starts_at<$5 AND r.ends_at>$4
                ) ORDER BY rm.capacity, rm.id LIMIT 5
            `,
            values: [tenantId, total, requestId, change.startsAt, change.endsAt],
          });
          return Object.freeze({ status: 'blocked', alternatives: alternatives.rows.map((row) => row.id) });
        }
        const applying = await client.query({
          name: 'booking-change-begin-approval',
          text: `UPDATE booking_change_requests SET status='applying', decided_by_user_id=$4, updated_at=$5
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 AND status='pending' RETURNING ${CHANGE_COLUMNS}`,
          values: [tenantId, requestId, changeId, deciderUserId, changedAt],
        });
        await appendAudit(client, auditRepository, auditEvent);
        return Object.freeze({ status: 'applying', change: changeRow(applying.rows[0]), request });
      });
    },

    async finishApproval({ tenantId, requestId, changeId, changedAt, auditEvent, calendarReplacement = null }) {
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockTenantLocationAuthority(client, tenantId)) {
          return Object.freeze({ status: 'conflict' });
        }
        const request = await lockRequest(client, tenantId, requestId);
        const locked = await client.query({
          name: 'booking-change-lock-applying',
          text: `SELECT ${CHANGE_COLUMNS} FROM booking_change_requests
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 FOR UPDATE`,
          values: [tenantId, requestId, changeId],
        });
        const change = changeRow(locked.rows[0]);
        if (!request || !change || change.status !== 'applying'
          || request.updatedAt !== change.baseRequestUpdatedAt) return Object.freeze({ status: 'conflict' });
        const target = await client.query({
          name: 'booking-change-finish-target-valid',
          text: `
            SELECT 1
            FROM rooms rm
            JOIN sites s ON s.tenant_id = rm.tenant_id AND s.id = rm.site_id
            WHERE rm.tenant_id = $1 AND rm.id = $2
              AND rm.active = TRUE AND s.active = TRUE AND s.time_zone IS NOT NULL
              AND rm.capacity >= $3
            FOR SHARE OF rm, s
          `,
          values: [
            tenantId,
            change.roomId,
            change.internalParticipants + change.externalParticipants,
          ],
        });
        if (target.rowCount !== 1) return Object.freeze({ status: 'conflict' });
        const updated = await client.query({
          name: 'booking-change-apply-request',
          text: `UPDATE requests SET room_id=$4, starts_at=$5, ends_at=$6,
              internal_participants=$7, external_participants=$8, updated_at=$9
            WHERE tenant_id=$1 AND id=$2 AND status='Confirmed' AND updated_at=$3
            RETURNING ${REQUEST_COLUMNS}`,
          values: [tenantId, requestId, new Date(change.baseRequestUpdatedAt), change.roomId,
            change.startsAt, change.endsAt, change.internalParticipants,
            change.externalParticipants, changedAt],
        });
        const nextRequest = requestRow(updated.rows[0]);
        if (!nextRequest) return Object.freeze({ status: 'conflict' });
        if (calendarReplacement) {
          const swapped = await client.query({
            name: 'booking-change-swap-provider-reference',
            text: `UPDATE booking_provider_references
              SET provider_reference=$6, provider_resource_reference=$7, idempotency_key=$8,
                attempt_number=attempt_number+1, updated_at=$9
              WHERE tenant_id=$1 AND request_id=$2 AND integration_id=$3
                AND provider_reference=$4 AND provider_resource_reference=$5 AND state='active'`,
            values: [tenantId, requestId, calendarReplacement.integrationId,
              calendarReplacement.previousProviderReference,
              calendarReplacement.previousProviderResourceReference,
              calendarReplacement.providerReference,
              calendarReplacement.providerResourceReference,
              calendarReplacement.idempotencyKey, changedAt],
          });
          if (swapped.rowCount !== 1) throw new BookingReferenceConflictError();
        }
        await client.query({
          name: 'booking-change-finish-approval',
          text: `UPDATE booking_change_requests SET status='applied', updated_at=$4
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 AND status='applying'`,
          values: [tenantId, requestId, changeId, changedAt],
        });
        await client.query({
          name: 'booking-change-notify-requester',
          text: 'INSERT INTO notifications (tenant_id,id,user_id,kind,created_at) VALUES ($1,$2,$3,$4,$5)',
          values: [tenantId, randomUUID(), request.requesterUserId, 'booking_change_applied', changedAt],
        });
        await appendAudit(client, auditRepository, auditEvent);
        return Object.freeze({ status: 'applied', request: nextRequest });
      });
    },

    async returnToPending({ tenantId, requestId, changeId, changedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'booking-change-retry-pending',
          text: `UPDATE booking_change_requests SET status='pending', decided_by_user_id=NULL, updated_at=$4
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 AND status='applying' RETURNING ${CHANGE_COLUMNS}`,
          values: [tenantId, requestId, changeId, changedAt],
        });
        if (!result.rows[0]) return null;
        await appendAudit(client, auditRepository, auditEvent);
        return changeRow(result.rows[0]);
      });
    },

    async reject({ tenantId, requestId, changeId, deciderUserId, reason, changedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'booking-change-reject',
          text: `UPDATE booking_change_requests SET status='rejected', decided_by_user_id=$4,
              rejection_reason=$5, updated_at=$6
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 AND status='pending' RETURNING ${CHANGE_COLUMNS}`,
          values: [tenantId, requestId, changeId, deciderUserId, reason, changedAt],
        });
        if (!result.rows[0]) return null;
        await appendAudit(client, auditRepository, auditEvent);
        return changeRow(result.rows[0]);
      });
    },
  });
}
