import { randomUUID } from 'node:crypto';
import {
  normalizeBookingChange,
  normalizeBookingChangeCalendarReplacement,
} from '../../domain/booking-change.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeRequest } from '../../domain/request.js';
import { BOOKING_POLICY_OPERATION } from '../../domain/tenant-booking-policies.js';
import {
  isIdempotencyKey,
  isProviderReference,
  isProviderResourceReference,
} from '../../integrations/calendar-contract.js';
import { BookingReferenceConflictError } from '../../integrations/errors.js';
import {
  appendRequestRevisionWithClient,
  lockFinalRequestRoomWithClient,
  lockRequestCompositionTenantWithClient,
  resolveCurrentRequestCompositionWithClient,
} from './request-repository.js';
import { withPostgresTransaction } from './transaction.js';

class BookingChangeStoreConflictError extends Error {}

const CHANGE_COLUMNS = `
  tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
  internal_participants, external_participants, base_request_updated_at,
  request_schema_version, base_request_version, request_draft, proposed_request_snapshot,
  move_attempt_number, recovery_phase, calendar_replacement,
  decided_by_user_id, rejection_reason, created_at, updated_at
`;

const REQUEST_COLUMNS = `
  tenant_id, id, requester_user_id, room_id, status, status_reason, starts_at, ends_at,
  internal_participants, external_participants, schema_version, request_version, request_snapshot,
  status_changed_at, created_at, updated_at
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
    requestSchemaVersion: Number(row.request_schema_version ?? 1),
    baseRequestVersion: Number(row.base_request_version ?? 1),
    requestDraft: row.request_draft ?? null,
    proposedRequestSnapshot: row.proposed_request_snapshot ?? null,
    moveAttemptNumber: Number(row.move_attempt_number ?? 0),
    recoveryPhase: row.recovery_phase ?? 'none',
    calendarReplacement: row.calendar_replacement ?? null,
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
    schemaVersion: Number(row.schema_version ?? 1),
    version: Number(row.request_version ?? 1),
    snapshot: row.request_snapshot ?? null,
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
    text: "SELECT 1 FROM tenants WHERE id = $1 AND status = 'active' FOR SHARE",
    values: [tenantId],
  });
  return result.rowCount === 1;
}

async function lockTenantForApprovalReconciliation(client, tenantId) {
  const result = await client.query({
    name: 'booking-change-reconciliation-tenant-lock',
    text: 'SELECT 1 FROM tenants WHERE id = $1 FOR SHARE',
    values: [tenantId],
  });
  return result.rowCount === 1;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function participantOnlyV2(request, draft) {
  if (request.schemaVersion !== 2 || !request.snapshot) return false;
  const details = request.snapshot.details;
  const allocations = request.snapshot.allocations.entries.map((entry) => ({
    costCenterId: entry.costCenterId,
    percentageBasisPoints: entry.percentageBasisPoints,
  }));
  const requestParticipantsChanged = draft.internalParticipants !== request.internalParticipants
    || draft.externalParticipants !== request.externalParticipants;
  return requestParticipantsChanged
    && draft.roomId === request.roomId
    && draft.startsAt === request.startsAt
    && draft.endsAt === request.endsAt
    && draft.title === details.title
    && draft.dietaryRequirements === details.dietaryRequirements
    && draft.specialRequirements === details.specialRequirements
    && sameJson(draft.serviceIds, details.serviceIds)
    && sameJson(draft.catering.packageSelection, details.catering.packageSelection)
    && sameJson(draft.catering.itemQuantities, details.catering.itemQuantities)
    && sameJson(draft.allocations, allocations)
    && sameJson(draft.configurationRevisions, request.snapshot.configurationRevisions);
}

function appliedRequestMatchesChange(request, change) {
  if (
    request.status !== 'Confirmed'
    || request.version !== change.baseRequestVersion + 1
    || request.roomId !== change.roomId
    || request.startsAt !== change.startsAt
    || request.endsAt !== change.endsAt
    || request.internalParticipants !== change.internalParticipants
    || request.externalParticipants !== change.externalParticipants
  ) return false;
  if (change.requestSchemaVersion === 1) return request.schemaVersion === 1;
  return request.schemaVersion === 2
    && sameJson(request.snapshot, change.proposedRequestSnapshot);
}

function calendarRestoration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('BOOKING_CHANGE_CALENDAR_RESTORATION_INVALID');
  }
  const keys = [
    'expectedProviderReference',
    'expectedProviderResourceReference',
    'idempotencyKey',
    'integrationId',
    'providerReference',
    'providerResourceReference',
  ];
  const actual = Object.keys(value).sort();
  if (
    actual.length !== keys.length
    || actual.some((key, index) => key !== keys[index])
    || !isInternalUuid(value.integrationId)
    || !isProviderReference(value.expectedProviderReference)
    || !isProviderResourceReference(value.expectedProviderResourceReference)
    || !isProviderReference(value.providerReference)
    || !isProviderResourceReference(value.providerResourceReference)
    || !isIdempotencyKey(value.idempotencyKey)
  ) throw new TypeError('BOOKING_CHANGE_CALENDAR_RESTORATION_INVALID');
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
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

    async propose({
      tenantId,
      requestId,
      changeId,
      initiatorUserId,
      expectedVersion,
      proposal,
      changedAt,
      auditEvent,
    }) {
      try {
        return await withPostgresTransaction(pool, async (client) => {
          if (!await lockRequestCompositionTenantWithClient(client, tenantId)) {
            return Object.freeze({ status: 'conflict' });
          }
          const request = await lockRequest(client, tenantId, requestId);
          if (
            !request
            || request.status !== 'Confirmed'
            || request.version !== expectedVersion
          ) return Object.freeze({ status: 'conflict' });
          const nextVersion = request.version + 1;
          const authority = await resolveCurrentRequestCompositionWithClient(client, {
            tenantId,
            actorUserId: initiatorUserId,
            draft: proposal,
            operation: BOOKING_POLICY_OPERATION.CHANGE,
            capturedAt: changedAt.toISOString(),
            requestVersion: nextVersion,
            changeWindowStartsAt: request.startsAt,
          });
          if (authority.status !== 'ready') return authority;
          const { draft, snapshot } = authority;
          const participantOnly = participantOnlyV2(request, draft);
          const status = participantOnly ? 'applied' : 'pending';
          const inserted = await client.query({
            name: 'booking-change-insert',
            text: `
              INSERT INTO booking_change_requests (
                tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
                internal_participants, external_participants, base_request_updated_at,
                request_schema_version, base_request_version, request_draft,
                proposed_request_snapshot,
                decided_by_user_id, rejection_reason, created_at, updated_at
              ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                2,$12,$13::jsonb,$14::jsonb,NULL,NULL,$15,$15
              )
              RETURNING ${CHANGE_COLUMNS}
            `,
            values: [
              tenantId, changeId, requestId, initiatorUserId, status, draft.roomId,
              new Date(draft.startsAt), new Date(draft.endsAt), draft.internalParticipants,
              draft.externalParticipants, new Date(request.updatedAt), request.version,
              JSON.stringify(draft), JSON.stringify(snapshot), changedAt,
            ],
          });
          let updatedRequest = request;
          if (participantOnly) {
            const updated = await client.query({
              name: 'booking-change-apply-v2-participants',
              text: `
                UPDATE requests
                SET internal_participants = $3,
                    external_participants = $4,
                    schema_version = 2,
                    request_version = $5,
                    request_snapshot = $6::jsonb,
                    updated_at = $7
                WHERE tenant_id = $1
                  AND id = $2
                  AND status = 'Confirmed'
                  AND request_version = $8
                RETURNING ${REQUEST_COLUMNS}
              `,
              values: [
                tenantId,
                requestId,
                draft.internalParticipants,
                draft.externalParticipants,
                nextVersion,
                JSON.stringify(snapshot),
                changedAt,
                request.version,
              ],
            });
            updatedRequest = requestRow(updated.rows[0]);
            if (!updatedRequest) throw new BookingChangeStoreConflictError();
            await appendRequestRevisionWithClient(
              client,
              updatedRequest,
              'booking_changed',
              auditEvent,
            );
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
        if (!request || !change || request.status !== 'Confirmed') {
          return Object.freeze({ status: 'conflict' });
        }
        if (change.status === 'applied') {
          return appliedRequestMatchesChange(request, change)
            ? Object.freeze({ status: 'applied', change, request })
            : Object.freeze({ status: 'conflict' });
        }
        if (
          !['pending', 'applying'].includes(change.status)
          || request.version !== change.baseRequestVersion
          || (change.requestSchemaVersion === 1 && request.updatedAt !== change.baseRequestUpdatedAt)
        ) return Object.freeze({ status: 'conflict' });
        if (change.status === 'applying') {
          if (change.recoveryPhase === 'reconciliation_required') {
            return Object.freeze({ status: 'reconciliation_required', change, request });
          }
          if (change.recoveryPhase === 'restore_pending') {
            return Object.freeze({ status: 'restoring', change, request });
          }
          if (change.recoveryPhase === 'target_active') {
            return Object.freeze({ status: 'finishing', change, request });
          }
          return Object.freeze({ status: 'applying', change, request });
        }
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
          return Object.freeze({
            status: 'blocked',
            alternatives: alternatives.rows.map((row) => row.id),
            change,
            request,
          });
        }
        const roomMove = request.roomId !== change.roomId;
        if (roomMove && change.moveAttemptNumber >= 2_147_483_647) {
          return Object.freeze({ status: 'conflict' });
        }
        const applying = await client.query({
          name: 'booking-change-begin-approval',
          text: `UPDATE booking_change_requests
            SET status='applying', decided_by_user_id=$4, updated_at=$5,
                move_attempt_number = move_attempt_number + CASE WHEN $6 THEN 1 ELSE 0 END,
                recovery_phase = CASE WHEN $6 THEN 'move_pending' ELSE 'none' END,
                calendar_replacement = NULL
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 AND status='pending'
            RETURNING ${CHANGE_COLUMNS}`,
          values: [tenantId, requestId, changeId, deciderUserId, changedAt, roomMove],
        });
        if (!applying.rows[0]) return Object.freeze({ status: 'conflict' });
        await appendAudit(client, auditRepository, auditEvent);
        return Object.freeze({ status: 'applying', change: changeRow(applying.rows[0]), request });
      });
    },

    async recordCalendarMoveTarget({
      tenantId,
      requestId,
      changeId,
      moveAttemptNumber,
      calendarReplacement: replacementValue,
      changedAt,
      auditEvent,
      calendarAuditEvent = null,
    }) {
      const replacement = normalizeBookingChangeCalendarReplacement(replacementValue);
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockTenantForApprovalReconciliation(client, tenantId)) return null;
        const request = await lockRequest(client, tenantId, requestId);
        if (!request) return null;
        const locked = await client.query({
          name: 'booking-change-lock-calendar-move-target',
          text: `SELECT ${CHANGE_COLUMNS} FROM booking_change_requests
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 FOR UPDATE`,
          values: [tenantId, requestId, changeId],
        });
        const current = changeRow(locked.rows[0]);
        if (
          !current
          || current.status !== 'applying'
          || current.moveAttemptNumber !== moveAttemptNumber
        ) return null;
        if (current.recoveryPhase === 'target_active') {
          return sameJson(current.calendarReplacement, replacement) ? current : null;
        }
        if (current.recoveryPhase !== 'move_pending') return null;
        const recorded = await client.query({
          name: 'booking-change-record-calendar-move-target',
          text: `
            UPDATE booking_change_requests
            SET recovery_phase = 'target_active',
                calendar_replacement = $5::jsonb,
                updated_at = $6
            WHERE tenant_id = $1
              AND request_id = $2
              AND id = $3
              AND status = 'applying'
              AND recovery_phase = 'move_pending'
              AND move_attempt_number = $4
            RETURNING ${CHANGE_COLUMNS}
          `,
          values: [
            tenantId,
            requestId,
            changeId,
            moveAttemptNumber,
            JSON.stringify(replacement),
            changedAt,
          ],
        });
        const change = changeRow(recorded.rows[0]);
        if (!change) return null;
        await appendAudit(client, auditRepository, auditEvent);
        if (calendarAuditEvent) await appendAudit(client, auditRepository, calendarAuditEvent);
        return change;
      });
    },

    async beginCalendarMoveRollback({
      tenantId,
      requestId,
      changeId,
      moveAttemptNumber,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockTenantForApprovalReconciliation(client, tenantId)) return null;
        const request = await lockRequest(client, tenantId, requestId);
        if (!request) return null;
        const locked = await client.query({
          name: 'booking-change-lock-calendar-move-rollback',
          text: `SELECT ${CHANGE_COLUMNS} FROM booking_change_requests
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 FOR UPDATE`,
          values: [tenantId, requestId, changeId],
        });
        const change = changeRow(locked.rows[0]);
        if (
          !change
          || change.status !== 'applying'
          || change.moveAttemptNumber !== moveAttemptNumber
          || !['target_active', 'restore_pending'].includes(change.recoveryPhase)
          || !change.calendarReplacement
        ) return null;
        if (change.recoveryPhase === 'restore_pending') return change;
        const restoring = await client.query({
          name: 'booking-change-begin-calendar-move-rollback',
          text: `UPDATE booking_change_requests
            SET recovery_phase='restore_pending', updated_at=$5
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3
              AND status='applying' AND recovery_phase='target_active'
              AND move_attempt_number=$4
            RETURNING ${CHANGE_COLUMNS}`,
          values: [tenantId, requestId, changeId, moveAttemptNumber, changedAt],
        });
        const restoringChange = changeRow(restoring.rows[0]);
        if (!restoringChange) return null;
        await appendAudit(client, auditRepository, auditEvent);
        return restoringChange;
      });
    },

    async completeCalendarMoveRollback({
      tenantId,
      requestId,
      changeId,
      moveAttemptNumber,
      restoration: restorationValue,
      changedAt,
      auditEvent,
      calendarAuditEvent = null,
    }) {
      const restoration = calendarRestoration(restorationValue);
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockTenantForApprovalReconciliation(client, tenantId)) return null;
        const request = await lockRequest(client, tenantId, requestId);
        if (!request) return null;
        const locked = await client.query({
          name: 'booking-change-lock-calendar-move-restoration',
          text: `SELECT ${CHANGE_COLUMNS} FROM booking_change_requests
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 FOR UPDATE`,
          values: [tenantId, requestId, changeId],
        });
        const change = changeRow(locked.rows[0]);
        if (
          !change
          || change.status !== 'applying'
          || change.recoveryPhase !== 'restore_pending'
          || change.moveAttemptNumber !== moveAttemptNumber
          || !change.calendarReplacement
          || restoration.integrationId !== change.calendarReplacement.integrationId
          || restoration.expectedProviderReference
            !== change.calendarReplacement.previousProviderReference
          || restoration.expectedProviderResourceReference
            !== change.calendarReplacement.previousProviderResourceReference
        ) return null;
        const swapped = await client.query({
          name: 'booking-change-restore-provider-reference',
          text: `UPDATE booking_provider_references
            SET provider_reference=$6, provider_resource_reference=$7,
              idempotency_key=$8, attempt_number=attempt_number+1, updated_at=$9
            WHERE tenant_id=$1 AND request_id=$2 AND integration_id=$3
              AND provider_reference=$4 AND provider_resource_reference=$5 AND state='active'`,
          values: [
            tenantId,
            requestId,
            restoration.integrationId,
            restoration.expectedProviderReference,
            restoration.expectedProviderResourceReference,
            restoration.providerReference,
            restoration.providerResourceReference,
            restoration.idempotencyKey,
            changedAt,
          ],
        });
        if (swapped.rowCount !== 1) throw new BookingReferenceConflictError();
        const pending = await client.query({
          name: 'booking-change-complete-calendar-move-rollback',
          text: `UPDATE booking_change_requests
            SET status='pending', decided_by_user_id=NULL, recovery_phase='none',
              calendar_replacement=NULL, updated_at=$5
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3
              AND status='applying' AND move_attempt_number=$4
              AND recovery_phase='restore_pending'
            RETURNING ${CHANGE_COLUMNS}`,
          values: [tenantId, requestId, changeId, moveAttemptNumber, changedAt],
        });
        const pendingChange = changeRow(pending.rows[0]);
        if (!pendingChange) throw new BookingChangeStoreConflictError();
        await appendAudit(client, auditRepository, auditEvent);
        if (calendarAuditEvent) await appendAudit(client, auditRepository, calendarAuditEvent);
        return pendingChange;
      });
    },

    async markCalendarMoveReconciliationRequired({
      tenantId,
      requestId,
      changeId,
      moveAttemptNumber,
      calendarReplacement: replacementValue = null,
      changedAt,
      auditEvent,
      calendarAuditEvent = null,
    }) {
      const replacement = replacementValue === null
        ? null
        : normalizeBookingChangeCalendarReplacement(replacementValue);
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockTenantForApprovalReconciliation(client, tenantId)) return null;
        const request = await lockRequest(client, tenantId, requestId);
        if (!request) return null;
        const locked = await client.query({
          name: 'booking-change-lock-calendar-reconciliation',
          text: `SELECT ${CHANGE_COLUMNS} FROM booking_change_requests
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 FOR UPDATE`,
          values: [tenantId, requestId, changeId],
        });
        const current = changeRow(locked.rows[0]);
        if (
          !current
          || current.status !== 'applying'
          || current.moveAttemptNumber !== moveAttemptNumber
        ) return null;
        if (current.recoveryPhase === 'reconciliation_required') {
          if (
            replacement !== null
            && current.calendarReplacement !== null
            && !sameJson(replacement, current.calendarReplacement)
          ) return null;
          if (replacement === null || current.calendarReplacement !== null) return current;
        }
        const marked = await client.query({
          name: 'booking-change-mark-calendar-reconciliation-required',
          text: `UPDATE booking_change_requests
            SET recovery_phase='reconciliation_required',
              calendar_replacement=COALESCE($5::jsonb, calendar_replacement),
              updated_at=$6
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3
              AND status='applying' AND move_attempt_number=$4
              AND recovery_phase IN (
                'move_pending', 'target_active', 'restore_pending', 'reconciliation_required'
              )
            RETURNING ${CHANGE_COLUMNS}`,
          values: [
            tenantId,
            requestId,
            changeId,
            moveAttemptNumber,
            replacement === null ? null : JSON.stringify(replacement),
            changedAt,
          ],
        });
        const change = changeRow(marked.rows[0]);
        if (!change) return null;
        await appendAudit(client, auditRepository, auditEvent);
        if (calendarAuditEvent) await appendAudit(client, auditRepository, calendarAuditEvent);
        return change;
      });
    },

    async findApprovalState({ tenantId, requestId, changeId }) {
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockTenantForApprovalReconciliation(client, tenantId)) {
          return Object.freeze({ status: 'conflict' });
        }
        const request = await lockRequest(client, tenantId, requestId);
        const result = await client.query({
          name: 'booking-change-reconciliation-lock-state',
          text: `
            SELECT ${CHANGE_COLUMNS}
            FROM booking_change_requests
            WHERE tenant_id = $1 AND request_id = $2 AND id = $3
            FOR UPDATE
          `,
          values: [tenantId, requestId, changeId],
        });
        const change = changeRow(result.rows[0]);
        if (!request || !change) return Object.freeze({ status: 'conflict' });
        if (
          change.status === 'applying'
          && (
            request.status !== 'Confirmed'
            || request.version !== change.baseRequestVersion
            || (change.requestSchemaVersion === 1
              && request.updatedAt !== change.baseRequestUpdatedAt)
          )
        ) return Object.freeze({ status: 'conflict' });
        if (change.status === 'applied' && !appliedRequestMatchesChange(request, change)) {
          return Object.freeze({ status: 'conflict' });
        }
        return Object.freeze({ status: change.status, change, request });
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
        if (
          !request
          || !change
          || change.status !== 'applying'
          || request.version !== change.baseRequestVersion
          || (change.requestSchemaVersion === 1 && request.updatedAt !== change.baseRequestUpdatedAt)
        ) return Object.freeze({ status: 'conflict' });
        const replacement = calendarReplacement === null
          ? null
          : normalizeBookingChangeCalendarReplacement(calendarReplacement);
        const roomMove = request.roomId !== change.roomId;
        if (
          (roomMove && (
            change.recoveryPhase !== 'target_active'
            || !replacement
            || !sameJson(replacement, change.calendarReplacement)
          ))
          || (!roomMove && (change.recoveryPhase !== 'none' || replacement !== null))
        ) return Object.freeze({ status: 'conflict' });
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
        if (target.rowCount !== 1) return Object.freeze({ status: 'blocked' });
        await lockFinalRequestRoomWithClient(client, tenantId, change.roomId);
        const overlap = await client.query({
          name: 'booking-change-finish-target-conflict',
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
          values: [tenantId, change.roomId, requestId, change.startsAt, change.endsAt],
        });
        if (overlap.rowCount > 0) return Object.freeze({ status: 'blocked' });
        const updated = change.requestSchemaVersion === 2
          ? await client.query({
            name: 'booking-change-apply-v2-request',
            text: `
              UPDATE requests
              SET room_id = $4,
                  starts_at = $5,
                  ends_at = $6,
                  internal_participants = $7,
                  external_participants = $8,
                  schema_version = 2,
                  request_version = $9,
                  request_snapshot = $10::jsonb,
                  updated_at = $11
              WHERE tenant_id = $1
                AND id = $2
                AND status = 'Confirmed'
                AND request_version = $3
              RETURNING ${REQUEST_COLUMNS}
            `,
            values: [
              tenantId,
              requestId,
              change.baseRequestVersion,
              change.requestDraft.roomId,
              new Date(change.requestDraft.startsAt),
              new Date(change.requestDraft.endsAt),
              change.requestDraft.internalParticipants,
              change.requestDraft.externalParticipants,
              change.baseRequestVersion + 1,
              JSON.stringify(change.proposedRequestSnapshot),
              changedAt,
            ],
          })
          : await client.query({
            name: 'booking-change-apply-legacy-request',
            text: `
              UPDATE requests
              SET room_id = $4,
                  starts_at = $5,
                  ends_at = $6,
                  internal_participants = $7,
                  external_participants = $8,
                  request_version = request_version + 1,
                  updated_at = $9
              WHERE tenant_id = $1
                AND id = $2
                AND status = 'Confirmed'
                AND updated_at = $3
              RETURNING ${REQUEST_COLUMNS}
            `,
            values: [
              tenantId, requestId, new Date(change.baseRequestUpdatedAt), change.roomId,
              change.startsAt, change.endsAt, change.internalParticipants,
              change.externalParticipants, changedAt,
            ],
          });
        const nextRequest = requestRow(updated.rows[0]);
        if (!nextRequest) return Object.freeze({ status: 'conflict' });
        await appendRequestRevisionWithClient(
          client,
          nextRequest,
          'booking_changed',
          auditEvent,
        );
        if (replacement) {
          const swapped = await client.query({
            name: 'booking-change-swap-provider-reference',
            text: `UPDATE booking_provider_references
              SET provider_reference=$6, provider_resource_reference=$7, idempotency_key=$8,
                attempt_number=attempt_number+1, updated_at=$9
              WHERE tenant_id=$1 AND request_id=$2 AND integration_id=$3
                AND provider_reference=$4 AND provider_resource_reference=$5 AND state='active'`,
            values: [tenantId, requestId, replacement.integrationId,
              replacement.previousProviderReference,
              replacement.previousProviderResourceReference,
              replacement.providerReference,
              replacement.providerResourceReference,
              replacement.idempotencyKey, changedAt],
          });
          if (swapped.rowCount !== 1) throw new BookingReferenceConflictError();
        }
        const applied = await client.query({
          name: 'booking-change-finish-approval',
          text: `UPDATE booking_change_requests
            SET status='applied', recovery_phase='none', calendar_replacement=NULL, updated_at=$4
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 AND status='applying'
            RETURNING ${CHANGE_COLUMNS}`,
          values: [tenantId, requestId, changeId, changedAt],
        });
        const appliedChange = changeRow(applied.rows[0]);
        if (!appliedChange) throw new BookingChangeStoreConflictError();
        await client.query({
          name: 'booking-change-notify-requester',
          text: 'INSERT INTO notifications (tenant_id,id,user_id,kind,created_at) VALUES ($1,$2,$3,$4,$5)',
          values: [tenantId, randomUUID(), request.requesterUserId, 'booking_change_applied', changedAt],
        });
        await appendAudit(client, auditRepository, auditEvent);
        return Object.freeze({ status: 'applied', change: appliedChange, request: nextRequest });
      });
    },

    async returnToPending({ tenantId, requestId, changeId, changedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'booking-change-retry-pending',
          text: `UPDATE booking_change_requests
            SET status='pending', decided_by_user_id=NULL, recovery_phase='none',
              calendar_replacement=NULL, updated_at=$4
            WHERE tenant_id=$1 AND request_id=$2 AND id=$3 AND status='applying'
              AND recovery_phase IN ('none', 'move_pending')
            RETURNING ${CHANGE_COLUMNS}`,
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
