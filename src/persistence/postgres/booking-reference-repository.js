import { normalizeBookingProviderReference } from '../../integrations/booking-reference.js';
import { BookingReferenceConflictError } from '../../integrations/errors.js';
import { withPostgresTransaction } from './transaction.js';

const REFERENCE_COLUMNS = `
  tenant_id,
  request_id,
  integration_id,
  attempt_number,
  provider_reference,
  provider_connection_reference,
  provider_resource_reference,
  idempotency_key,
  state,
  created_correlation_id,
  created_at,
  updated_at
`;

function mapRow(row) {
  if (!row) return null;
  return normalizeBookingProviderReference({
    tenantId: row.tenant_id,
    requestId: row.request_id,
    integrationId: row.integration_id,
    attemptNumber: Number(row.attempt_number),
    providerReference: row.provider_reference,
    providerConnectionReference: row.provider_connection_reference,
    providerResourceReference: row.provider_resource_reference,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    createdCorrelationId: row.created_correlation_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

async function lockReference(client, tenantId, requestId, integrationId) {
  const key = `${tenantId}:${requestId}:${integrationId}`;
  await client.query({
    name: 'booking-reference-lock',
    text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    values: [key],
  });
}

async function findWithClient(client, tenantId, requestId, integrationId) {
  const result = await client.query({
    name: 'booking-reference-find-with-client',
    text: `
      SELECT ${REFERENCE_COLUMNS}
      FROM booking_provider_references
      WHERE tenant_id = $1
        AND request_id = $2
        AND integration_id = $3
      LIMIT 1
    `,
    values: [tenantId, requestId, integrationId],
  });
  return mapRow(result.rows[0]);
}

async function lockCurrentCreateAuthority(
  client,
  tenantId,
  integrationId,
  providerConnectionReference,
) {
  const integration = await client.query({
    name: 'booking-lock-current-create-authority',
    text: `
      SELECT provider, provider_reference, status
      FROM integrations
      WHERE tenant_id = $1
        AND id = $2
      FOR SHARE
    `,
    values: [tenantId, integrationId],
  });
  const row = integration.rows[0];
  if (
    !row
    || row.provider_reference !== providerConnectionReference
    || row.status !== 'connected'
  ) {
    return false;
  }
  if (row.provider !== 'microsoft365') return true;
  const binding = await client.query({
    name: 'booking-lock-current-entra-authority',
    text: `
      SELECT 1
      FROM tenant_identity_bindings
      WHERE tenant_id = $1
        AND provider = 'microsoft_entra'
        AND provider_tenant_reference = $2
        AND status = 'active'
      FOR SHARE
    `,
    values: [tenantId, providerConnectionReference],
  });
  return binding.rowCount === 1;
}

async function lockCurrentCleanupAuthority(
  client,
  tenantId,
  integrationId,
  providerConnectionReference,
) {
  const integration = await client.query({
    name: 'booking-lock-current-cleanup-authority',
    text: `
      SELECT provider, provider_reference
      FROM integrations
      WHERE tenant_id = $1
        AND id = $2
      FOR SHARE
    `,
    values: [tenantId, integrationId],
  });
  const row = integration.rows[0];
  if (!row || row.provider_reference !== providerConnectionReference) return false;
  if (row.provider !== 'microsoft365') return true;
  const binding = await client.query({
    name: 'booking-lock-current-entra-cleanup-authority',
    text: `
      SELECT 1
      FROM tenant_identity_bindings
      WHERE tenant_id = $1
        AND provider = 'microsoft_entra'
        AND provider_tenant_reference = $2
        AND status = 'active'
      FOR SHARE
    `,
    values: [tenantId, providerConnectionReference],
  });
  return binding.rowCount === 1;
}

export function createPostgresBookingReferenceRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async hasProviderReferenceByRequest(tenantId, requestId) {
      const result = await pool.query({
        name: 'booking-reference-exists-for-request',
        text: `
          SELECT 1
          FROM booking_provider_references
          WHERE tenant_id = $1
            AND request_id = $2
            AND state <> 'cancelled'
          LIMIT 1
        `,
        values: [tenantId, requestId],
      });
      return result.rowCount > 0;
    },

    async findProviderReferenceForCancellation(tenantId, requestId) {
      const result = await pool.query({
        name: 'booking-reference-find-for-cancellation',
        text: `
          SELECT ${REFERENCE_COLUMNS}
          FROM booking_provider_references
          WHERE tenant_id = $1
            AND request_id = $2
            AND state <> 'cancelled'
          ORDER BY updated_at DESC
          LIMIT 2
        `,
        values: [tenantId, requestId],
      });
      if (result.rowCount > 1) throw new BookingReferenceConflictError();
      return mapRow(result.rows[0]);
    },

    async hasConflictingRequest({ tenantId, roomId, startsAt, endsAt, excludeRequestId }) {
      const result = await pool.query({
        name: 'booking-request-conflict',
        text: `
          SELECT 1
          FROM requests
          WHERE tenant_id = $1
            AND room_id = $2
            AND ($3::text IS NULL OR id <> $3)
            AND status NOT IN ('Rejected', 'Cancelled')
            AND starts_at < $5
            AND ends_at > $4
          LIMIT 1
        `,
        values: [tenantId, roomId, excludeRequestId, startsAt, endsAt],
      });
      return result.rowCount > 0;
    },

    async findProviderReferenceByRequest(tenantId, requestId, integrationId) {
      const result = await pool.query({
        name: 'booking-reference-find',
        text: `
          SELECT ${REFERENCE_COLUMNS}
          FROM booking_provider_references
          WHERE tenant_id = $1
            AND request_id = $2
            AND integration_id = $3
          LIMIT 1
        `,
        values: [tenantId, requestId, integrationId],
      });
      return mapRow(result.rows[0]);
    },

    async reserveProviderResourceBinding({
      tenantId,
      requestId,
      integrationId,
      providerConnectionReference,
      providerResourceReference,
      idempotencyKey,
      correlationId,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        await lockReference(client, tenantId, requestId, integrationId);
        const request = await client.query({
          name: 'booking-resource-binding-lock-eligible-request',
          text: `
            SELECT 1
            FROM requests
            WHERE tenant_id = $1
              AND id = $2
              AND status IN ('Submitted', 'In Review')
            FOR SHARE
          `,
          values: [tenantId, requestId],
        });
        if (request.rowCount !== 1) throw new BookingReferenceConflictError();
        if (!await lockCurrentCreateAuthority(
          client,
          tenantId,
          integrationId,
          providerConnectionReference,
        )) throw new BookingReferenceConflictError();
        const existing = await findWithClient(client, tenantId, requestId, integrationId);
        if (existing) {
          if (
            existing.state === 'cancelled'
            || existing.idempotencyKey !== idempotencyKey
            || existing.providerConnectionReference !== providerConnectionReference
          ) {
            throw new BookingReferenceConflictError();
          }
          return Object.freeze({ reference: existing, created: false });
        }
        const result = await client.query({
          name: 'booking-resource-binding-reserve',
          text: `
            INSERT INTO booking_provider_references (
              tenant_id,
              request_id,
              integration_id,
              attempt_number,
              provider_reference,
              provider_connection_reference,
              provider_resource_reference,
              idempotency_key,
              state,
              created_correlation_id,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, 1, NULL, $4, $5, $6, 'pending', $7, $8, $8)
            RETURNING ${REFERENCE_COLUMNS}
          `,
          values: [
            tenantId,
            requestId,
            integrationId,
            providerConnectionReference,
            providerResourceReference,
            idempotencyKey,
            correlationId,
            changedAt,
          ],
        });
        const reference = mapRow(result.rows[0]);
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({ reference, created: true });
      });
    },

    async retryProviderResourceBinding({
      tenantId,
      requestId,
      integrationId,
      providerConnectionReference,
      providerResourceReference,
      nextAttemptNumber,
      idempotencyKey,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        await lockReference(client, tenantId, requestId, integrationId);
        const request = await client.query({
          name: 'booking-resource-retry-lock-eligible-request',
          text: `
            SELECT 1
            FROM requests
            WHERE tenant_id = $1
              AND id = $2
              AND status IN ('Submitted', 'In Review')
            FOR SHARE
          `,
          values: [tenantId, requestId],
        });
        if (request.rowCount !== 1) throw new BookingReferenceConflictError();
        if (!await lockCurrentCreateAuthority(
          client,
          tenantId,
          integrationId,
          providerConnectionReference,
        )) throw new BookingReferenceConflictError();
        const existing = await findWithClient(client, tenantId, requestId, integrationId);
        if (
          existing?.state === 'pending'
          && existing.attemptNumber === nextAttemptNumber
          && existing.idempotencyKey === idempotencyKey
          && existing.providerConnectionReference === providerConnectionReference
          && existing.providerResourceReference === providerResourceReference
        ) {
          return Object.freeze({ reference: existing, created: false });
        }
        if (
          !existing
          || existing.state !== 'compensated'
          || existing.attemptNumber + 1 !== nextAttemptNumber
          || existing.providerConnectionReference !== providerConnectionReference
        ) {
          throw new BookingReferenceConflictError();
        }
        const result = await client.query({
          name: 'booking-resource-binding-retry',
          text: `
            UPDATE booking_provider_references
            SET provider_reference = NULL,
                attempt_number = $4,
                idempotency_key = $5,
                provider_resource_reference = $6,
                state = 'pending',
                updated_at = $7
            WHERE tenant_id = $1
              AND request_id = $2
              AND integration_id = $3
              AND state = 'compensated'
              AND attempt_number = $4 - 1
            RETURNING ${REFERENCE_COLUMNS}
          `,
          values: [
            tenantId,
            requestId,
            integrationId,
            nextAttemptNumber,
            idempotencyKey,
            providerResourceReference,
            changedAt,
          ],
        });
        const reference = mapRow(result.rows[0]);
        if (!reference) throw new BookingReferenceConflictError();
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({ reference, created: true });
      });
    },

    async createProviderReference({
      tenantId,
      requestId,
      integrationId,
      providerReference,
      providerConnectionReference,
      providerResourceReference,
      idempotencyKey,
      correlationId,
      changedAt,
      auditEvent,
      authorityLossAuditEvent,
      allowDisconnectedCleanup = false,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        await lockReference(client, tenantId, requestId, integrationId);
        const createAuthorityCurrent = await lockCurrentCreateAuthority(
          client,
          tenantId,
          integrationId,
          providerConnectionReference,
        );
        const authorityCurrent = createAuthorityCurrent || (
          allowDisconnectedCleanup === true
          && await lockCurrentCleanupAuthority(
            client,
            tenantId,
            integrationId,
            providerConnectionReference,
          )
        );
        const existing = await findWithClient(client, tenantId, requestId, integrationId);
        if (existing) {
          if (
            existing.state === 'cancelled'
            || existing.idempotencyKey !== idempotencyKey
            || existing.providerConnectionReference !== providerConnectionReference
            || existing.providerResourceReference !== providerResourceReference
          ) {
            throw new BookingReferenceConflictError();
          }
          if (existing.state === 'active' && existing.providerReference === providerReference) {
            if (!authorityCurrent) throw new BookingReferenceConflictError();
            return Object.freeze({ reference: existing, created: false });
          }
          if (existing.state === 'active') throw new BookingReferenceConflictError();
          const reactivated = await client.query({
            name: 'booking-reference-reconcile-create',
            text: `
              UPDATE booking_provider_references
              SET provider_reference = $4,
                provider_resource_reference = $5,
                state = $6,
                updated_at = $7
              WHERE tenant_id = $1
                AND request_id = $2
                AND integration_id = $3
                AND state = 'pending'
              RETURNING ${REFERENCE_COLUMNS}
            `,
            values: [
              tenantId,
              requestId,
              integrationId,
              providerReference,
              providerResourceReference,
              authorityCurrent ? 'active' : 'compensating',
              changedAt,
            ],
          });
          const reference = mapRow(reactivated.rows[0]);
          if (!reference) throw new BookingReferenceConflictError();
          const audit = await auditRepository.appendWithClient(
            client,
            authorityCurrent ? auditEvent : authorityLossAuditEvent,
          );
          if (!audit) throw new Error('AUDIT_APPEND_FAILED');
          return Object.freeze({ reference, created: true, authorityLost: !authorityCurrent });
        }
        throw new BookingReferenceConflictError();
      });
    },

    async touchProviderReference({
      tenantId,
      requestId,
      integrationId,
      providerReference,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'booking-reference-touch',
          text: `
            UPDATE booking_provider_references
            SET updated_at = $5
            WHERE tenant_id = $1
              AND request_id = $2
              AND integration_id = $3
              AND provider_reference = $4
              AND state = 'active'
            RETURNING ${REFERENCE_COLUMNS}
          `,
          values: [tenantId, requestId, integrationId, providerReference, changedAt],
        });
        const reference = mapRow(result.rows[0]);
        if (!reference) throw new BookingReferenceConflictError();
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return reference;
      });
    },

    async replaceActiveProviderReference({
      tenantId,
      requestId,
      integrationId,
      expectedProviderReference,
      providerReference,
      providerResourceReference,
      idempotencyKey,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        await lockReference(client, tenantId, requestId, integrationId);
        const result = await client.query({
          name: 'booking-reference-replace-active',
          text: `UPDATE booking_provider_references
            SET provider_reference=$5, provider_resource_reference=$6, idempotency_key=$7,
              attempt_number=attempt_number+1, updated_at=$8
            WHERE tenant_id=$1 AND request_id=$2 AND integration_id=$3
              AND provider_reference=$4 AND state='active'
            RETURNING ${REFERENCE_COLUMNS}`,
          values: [tenantId, requestId, integrationId, expectedProviderReference,
            providerReference, providerResourceReference, idempotencyKey, changedAt],
        });
        const reference = mapRow(result.rows[0]);
        if (!reference) throw new BookingReferenceConflictError();
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return reference;
      });
    },

    async cancelProviderReference({
      tenantId,
      requestId,
      integrationId,
      providerReference,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        await lockReference(client, tenantId, requestId, integrationId);
        const existing = await findWithClient(client, tenantId, requestId, integrationId);
        if (
          existing?.state === 'cancelled'
          && existing.providerReference === providerReference
        ) {
          return existing;
        }
        const result = await client.query({
          name: 'booking-reference-cancel',
          text: `
            UPDATE booking_provider_references
            SET state = 'cancelled',
              updated_at = $5
            WHERE tenant_id = $1
              AND request_id = $2
              AND integration_id = $3
              AND provider_reference = $4
              AND state IN ('active', 'compensating', 'compensated')
            RETURNING ${REFERENCE_COLUMNS}
          `,
          values: [tenantId, requestId, integrationId, providerReference, changedAt],
        });
        const reference = mapRow(result.rows[0]);
        if (!reference) throw new BookingReferenceConflictError();
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return reference;
      });
    },

    async beginCompensatingProviderReference({
      tenantId,
      requestId,
      integrationId,
      providerReference,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        await lockReference(client, tenantId, requestId, integrationId);
        const existing = await findWithClient(client, tenantId, requestId, integrationId);
        if (
          existing?.state === 'compensating'
          && existing.providerReference === providerReference
        ) {
          return existing;
        }
        const result = await client.query({
          name: 'booking-reference-begin-compensating',
          text: `
            UPDATE booking_provider_references
            SET state = 'compensating',
              updated_at = $5
            WHERE tenant_id = $1
              AND request_id = $2
              AND integration_id = $3
              AND provider_reference = $4
              AND state = 'active'
            RETURNING ${REFERENCE_COLUMNS}
          `,
          values: [tenantId, requestId, integrationId, providerReference, changedAt],
        });
        const reference = mapRow(result.rows[0]);
        if (!reference) throw new BookingReferenceConflictError();
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return reference;
      });
    },

    async completeCompensatingProviderReference({
      tenantId,
      requestId,
      integrationId,
      providerReference,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        await lockReference(client, tenantId, requestId, integrationId);
        const existing = await findWithClient(client, tenantId, requestId, integrationId);
        if (
          existing?.state === 'compensated'
          && existing.providerReference === providerReference
        ) {
          return existing;
        }
        const result = await client.query({
          name: 'booking-reference-complete-compensating',
          text: `
            UPDATE booking_provider_references
            SET state = 'compensated',
              updated_at = $5
            WHERE tenant_id = $1
              AND request_id = $2
              AND integration_id = $3
              AND provider_reference = $4
              AND state = 'compensating'
            RETURNING ${REFERENCE_COLUMNS}
          `,
          values: [tenantId, requestId, integrationId, providerReference, changedAt],
        });
        const reference = mapRow(result.rows[0]);
        if (!reference) throw new BookingReferenceConflictError();
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return reference;
      });
    },
  });
}
