import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const PROVIDER = 'microsoft365';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const STATUSES = new Set(['pending', 'connected', 'degraded', 'revoked', 'disconnected']);
const PLACES_PERMISSION = new Set(['granted', 'missing', 'unknown']);
const CALENDARS_PERMISSION = new Set(['granted', 'missing', 'unknown', 'unverified']);
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function assertUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
}

function assertDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(code);
}

function assertProviderTenant(value) {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) throw new TypeError('MICROSOFT365_PROVIDER_TENANT_INVALID');
}

function assertHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new TypeError('MICROSOFT365_STATE_HASH_INVALID');
}

function normalizeStatus(value) {
  if (!STATUSES.has(value)) throw new TypeError('MICROSOFT365_CONNECTION_STATUS_INVALID');
  return value;
}

function normalizeReason(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !REASON_PATTERN.test(value)) throw new TypeError('MICROSOFT365_CONNECTION_REASON_INVALID');
  return value;
}

function normalizePermission(value, allowed, code) {
  if (!allowed.has(value)) throw new TypeError(code);
  return value;
}

function mapConnection(row) {
  if (!row) return null;
  return Object.freeze({
    tenantId: row.tenant_id,
    integrationId: row.id,
    providerTenantReference: row.provider_reference,
    status: row.status,
    connectionVersion: Number(row.connection_version),
    lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : null,
    reason: row.connection_reason ?? null,
    placesPermission: row.places_permission_status ?? 'unknown',
    calendarsPermission: row.calendars_permission_status ?? 'unknown',
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

async function appendAudit(client, auditRepository, event) {
  if (!event) return;
  const appended = await auditRepository.appendWithClient(client, event);
  if (!appended) throw new Error('AUDIT_APPEND_FAILED');
}

async function tenantLock(client, tenantId) {
  await client.query({
    name: 'microsoft365-connection-lock',
    text: 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    values: [`microsoft365-connection:${tenantId}`],
  });
}

export function createPostgresMicrosoft365ConnectionRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async findByTenantId(tenantId) {
      assertUuid(tenantId, 'MICROSOFT365_TENANT_ID_INVALID');
      const result = await pool.query({
        name: 'microsoft365-connection-find',
        text: `
          SELECT
            tenant_id, id, provider_reference, status, connection_version,
            last_verified_at, connection_reason, places_permission_status,
            calendars_permission_status, updated_at
          FROM integrations
          WHERE tenant_id = $1 AND provider = '${PROVIDER}'
        `,
        values: [tenantId],
      });
      return mapConnection(result.rows[0]);
    },

    async startConsent({
      tenantId,
      actorUserId,
      integrationId,
      transactionId,
      providerTenantReference,
      stateHash,
      createdAt,
      expiresAt,
      auditEventFor,
    }) {
      assertUuid(tenantId, 'MICROSOFT365_TENANT_ID_INVALID');
      assertUuid(actorUserId, 'MICROSOFT365_ACTOR_ID_INVALID');
      assertUuid(integrationId, 'MICROSOFT365_INTEGRATION_ID_INVALID');
      assertUuid(transactionId, 'MICROSOFT365_TRANSACTION_ID_INVALID');
      assertProviderTenant(providerTenantReference);
      assertHash(stateHash);
      assertDate(createdAt, 'MICROSOFT365_CREATED_AT_INVALID');
      assertDate(expiresAt, 'MICROSOFT365_EXPIRES_AT_INVALID');
      if (expiresAt <= createdAt) throw new TypeError('MICROSOFT365_EXPIRY_INVALID');
      if (typeof auditEventFor !== 'function') throw new TypeError('MICROSOFT365_AUDIT_FACTORY_REQUIRED');

      return withPostgresTransaction(pool, async (client) => {
        await tenantLock(client, tenantId);
        const existing = await client.query({
          name: 'microsoft365-connection-lock-existing',
          text: `
            SELECT id, provider_reference, status, connection_version
            FROM integrations
            WHERE tenant_id = $1 AND provider = '${PROVIDER}'
            FOR UPDATE
          `,
          values: [tenantId],
        });
        const current = existing.rows[0];
        if (current && current.provider_reference !== providerTenantReference) {
          return Object.freeze({ status: 'provider_mismatch' });
        }

        let id = integrationId;
        let previousStatus = null;
        let version;
        if (!current) {
          version = 1;
          await client.query({
            name: 'microsoft365-connection-insert',
            text: `
              INSERT INTO integrations (
                tenant_id, id, provider, provider_reference, status,
                connection_version, connection_reason,
                places_permission_status, calendars_permission_status,
                created_at, updated_at
              )
              VALUES ($1, $2, '${PROVIDER}', $3, 'pending', $4, NULL, 'unknown', 'unknown', $5, $5)
            `,
            values: [tenantId, id, providerTenantReference, version, createdAt],
          });
        } else {
          id = current.id;
          previousStatus = current.status;
          version = Number(current.connection_version) + 1;
          await client.query({
            name: 'microsoft365-connection-reset-pending',
            text: `
              UPDATE integrations
              SET status = 'pending',
                  connection_version = $3,
                  connection_reason = NULL,
                  places_permission_status = 'unknown',
                  calendars_permission_status = 'unknown',
                  updated_at = $4
              WHERE tenant_id = $1 AND id = $2
            `,
            values: [tenantId, id, version, createdAt],
          });
        }

        await client.query({
          name: 'microsoft365-consent-delete-older',
          text: 'DELETE FROM microsoft365_consent_transactions WHERE tenant_id = $1 AND integration_id = $2',
          values: [tenantId, id],
        });
        await client.query({
          name: 'microsoft365-consent-insert',
          text: `
            INSERT INTO microsoft365_consent_transactions (
              id, tenant_id, actor_user_id, integration_id, provider_tenant_reference,
              connection_version, state_hash, created_at, expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          values: [
            transactionId,
            tenantId,
            actorUserId,
            id,
            providerTenantReference,
            version,
            stateHash,
            createdAt,
            expiresAt,
          ],
        });
        await appendAudit(client, auditRepository, auditEventFor({
          integrationId: id,
          previousStatus,
          nextStatus: 'pending',
        }));
        return Object.freeze({ status: 'pending', integrationId: id, connectionVersion: version });
      });
    },

    async consumeConsent({ tenantId, actorUserId, stateHash, now }) {
      assertUuid(tenantId, 'MICROSOFT365_TENANT_ID_INVALID');
      assertUuid(actorUserId, 'MICROSOFT365_ACTOR_ID_INVALID');
      assertHash(stateHash);
      assertDate(now, 'MICROSOFT365_NOW_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        await tenantLock(client, tenantId);
        const result = await client.query({
          name: 'microsoft365-consent-consume',
          text: `
            DELETE FROM microsoft365_consent_transactions
            WHERE tenant_id = $1
              AND actor_user_id = $2
              AND state_hash = $3
              AND expires_at > $4
            RETURNING integration_id, provider_tenant_reference, connection_version
          `,
          values: [tenantId, actorUserId, stateHash, now],
        });
        const row = result.rows[0];
        if (!row) return null;
        return Object.freeze({
          integrationId: row.integration_id,
          providerTenantReference: row.provider_tenant_reference,
          connectionVersion: Number(row.connection_version),
        });
      });
    },

    async finalizeConsent({
      tenantId,
      integrationId,
      connectionVersion,
      status,
      placesPermission,
      calendarsPermission,
      reason,
      changedAt,
      auditEvents = [],
    }) {
      assertUuid(tenantId, 'MICROSOFT365_TENANT_ID_INVALID');
      assertUuid(integrationId, 'MICROSOFT365_INTEGRATION_ID_INVALID');
      if (!Number.isSafeInteger(connectionVersion) || connectionVersion < 1) throw new TypeError('MICROSOFT365_VERSION_INVALID');
      const normalizedStatus = normalizeStatus(status);
      const normalizedPlaces = normalizePermission(placesPermission, PLACES_PERMISSION, 'MICROSOFT365_PLACES_PERMISSION_INVALID');
      const normalizedCalendars = normalizePermission(calendarsPermission, CALENDARS_PERMISSION, 'MICROSOFT365_CALENDARS_PERMISSION_INVALID');
      const normalizedReason = normalizeReason(reason);
      assertDate(changedAt, 'MICROSOFT365_CHANGED_AT_INVALID');
      if (!Array.isArray(auditEvents) || auditEvents.length > 3) throw new TypeError('MICROSOFT365_AUDIT_EVENTS_INVALID');

      return withPostgresTransaction(pool, async (client) => {
        await tenantLock(client, tenantId);
        const updated = await client.query({
          name: 'microsoft365-connection-finalize',
          text: `
            UPDATE integrations
            SET status = $4,
                places_permission_status = $5,
                calendars_permission_status = $6,
                connection_reason = $7,
                last_verified_at = $8,
                updated_at = $8
            WHERE tenant_id = $1
              AND id = $2
              AND provider = '${PROVIDER}'
              AND connection_version = $3
            RETURNING
              tenant_id, id, provider_reference, status, connection_version,
              last_verified_at, connection_reason, places_permission_status,
              calendars_permission_status, updated_at
          `,
          values: [
            tenantId,
            integrationId,
            connectionVersion,
            normalizedStatus,
            normalizedPlaces,
            normalizedCalendars,
            normalizedReason,
            changedAt,
          ],
        });
        if (updated.rowCount !== 1) return Object.freeze({ status: 'stale' });
        for (const event of auditEvents) await appendAudit(client, auditRepository, event);
        return Object.freeze({ status: 'updated', connection: mapConnection(updated.rows[0]) });
      });
    },

    async disconnect({ tenantId, changedAt, auditEventFor }) {
      assertUuid(tenantId, 'MICROSOFT365_TENANT_ID_INVALID');
      assertDate(changedAt, 'MICROSOFT365_CHANGED_AT_INVALID');
      if (typeof auditEventFor !== 'function') throw new TypeError('MICROSOFT365_AUDIT_FACTORY_REQUIRED');

      return withPostgresTransaction(pool, async (client) => {
        await tenantLock(client, tenantId);
        const current = await client.query({
          name: 'microsoft365-connection-disconnect-lock',
          text: `
            SELECT id, status, connection_version
            FROM integrations
            WHERE tenant_id = $1 AND provider = '${PROVIDER}'
            FOR UPDATE
          `,
          values: [tenantId],
        });
        const row = current.rows[0];
        if (!row) return null;
        if (row.status === 'disconnected') {
          return this.findByTenantId(tenantId);
        }
        const version = Number(row.connection_version) + 1;
        await client.query({
          name: 'microsoft365-consent-delete-on-disconnect',
          text: 'DELETE FROM microsoft365_consent_transactions WHERE tenant_id = $1 AND integration_id = $2',
          values: [tenantId, row.id],
        });
        const updated = await client.query({
          name: 'microsoft365-connection-disconnect',
          text: `
            UPDATE integrations
            SET status = 'disconnected',
                connection_version = $3,
                connection_reason = NULL,
                updated_at = $4
            WHERE tenant_id = $1 AND id = $2
            RETURNING
              tenant_id, id, provider_reference, status, connection_version,
              last_verified_at, connection_reason, places_permission_status,
              calendars_permission_status, updated_at
          `,
          values: [tenantId, row.id, version, changedAt],
        });
        await appendAudit(client, auditRepository, auditEventFor({
          integrationId: row.id,
          previousStatus: row.status,
          nextStatus: 'disconnected',
        }));
        return mapConnection(updated.rows[0]);
      });
    },
  });
}
