import { normalizeBookingProviderReference } from '../../integrations/booking-reference.js';
import { BookingReferenceConflictError } from '../../integrations/errors.js';
import { withPostgresTransaction } from './transaction.js';

const REFERENCE_COLUMNS = `
  tenant_id,
  request_id,
  integration_id,
  provider_reference,
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
    providerReference: row.provider_reference,
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

function sameCreate(existing, providerReference, idempotencyKey) {
  return existing.providerReference === providerReference
    && existing.idempotencyKey === idempotencyKey;
}

export function createPostgresBookingReferenceRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async hasConflictingRequest({ tenantId, roomId, startsAt, endsAt, excludeRequestId }) {
      const result = await pool.query({
        name: 'booking-request-conflict',
        text: `
          SELECT 1
          FROM requests
          WHERE tenant_id = $1
            AND room_id = $2
            AND id <> $3
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

    async createProviderReference({
      tenantId,
      requestId,
      integrationId,
      providerReference,
      idempotencyKey,
      correlationId,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        await lockReference(client, tenantId, requestId, integrationId);
        const existing = await findWithClient(client, tenantId, requestId, integrationId);
        if (existing) {
          if (!sameCreate(existing, providerReference, idempotencyKey)) throw new BookingReferenceConflictError();
          return Object.freeze({ reference: existing, created: false });
        }
        const result = await client.query({
          name: 'booking-reference-create',
          text: `
            INSERT INTO booking_provider_references (
              tenant_id,
              request_id,
              integration_id,
              provider_reference,
              idempotency_key,
              state,
              created_correlation_id,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7)
            RETURNING ${REFERENCE_COLUMNS}
          `,
          values: [
            tenantId,
            requestId,
            integrationId,
            providerReference,
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

    async cancelProviderReference({
      tenantId,
      requestId,
      integrationId,
      providerReference,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
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
  });
}
