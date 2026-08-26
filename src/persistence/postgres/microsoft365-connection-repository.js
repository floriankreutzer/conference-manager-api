import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const PROVIDER = 'microsoft365';
const IDENTITY_PROVIDER = 'microsoft_entra';
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

function assertNullableDate(value, code) {
  if (value !== null) assertDate(value, code);
}

function assertProviderTenant(value) {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) {
    throw new TypeError('MICROSOFT365_PROVIDER_TENANT_INVALID');
  }
}

function assertNullableProviderTenant(value) {
  if (value !== null) assertProviderTenant(value);
}

function assertHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new TypeError('MICROSOFT365_STATE_HASH_INVALID');
  }
}

function normalizeStatus(value) {
  if (!STATUSES.has(value)) throw new TypeError('MICROSOFT365_CONNECTION_STATUS_INVALID');
  return value;
}

function normalizeReason(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !REASON_PATTERN.test(value)) {
    throw new TypeError('MICROSOFT365_CONNECTION_REASON_INVALID');
  }
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
      if (typeof auditEventFor !== 'function') {
        throw new TypeError('MICROSOFT365_AUDIT_FACTORY_REQUIRED');
      }

      return withPostgresTransaction(pool, async (client) => {
        await tenantLock(client, tenantId);
        const existing = await client.query({
          name: 'microsoft365-connection-lock-existing',
          text: `
            SELECT
              id, provider_reference, status, connection_version,
              last_verified_at, connection_reason, places_permission_status,
              calendars_permission_status
            FROM integrations
            WHERE tenant_id = $1 AND provider = '${PROVIDER}'
            FOR UPDATE
          `,
          values: [tenantId],
        });
        const current = existing.rows[0];
        const activeBinding = await client.query({
          name: 'microsoft365-lock-active-provider-tenant-binding',
          text: `
            SELECT 1
            FROM tenant_identity_bindings
            WHERE tenant_id = $1
              AND provider = '${IDENTITY_PROVIDER}'
              AND provider_tenant_reference = $2
              AND status = 'active'
            FOR SHARE
          `,
          values: [tenantId, providerTenantReference],
        });
        if (activeBinding.rowCount !== 1) {
          return Object.freeze({ status: 'binding_unavailable' });
        }

        let id = integrationId;
        let previousStatus = null;
        let nextStatus = 'pending';
        let providerRebound = false;
        let version;
        if (!current) {
          version = 1;
          await client.query({
            name: 'microsoft365-connection-insert',
            text: `
              INSERT INTO integrations (
                tenant_id, id, provider, provider_reference, status,
                connection_version, connection_reason, last_verified_at,
                places_permission_status, calendars_permission_status,
                created_at, updated_at
              )
              VALUES ($1, $2, '${PROVIDER}', $3, 'pending', $4, NULL, NULL, 'unknown', 'unknown', $5, $5)
            `,
            values: [tenantId, id, providerTenantReference, version, createdAt],
          });
        } else {
          id = current.id;
          previousStatus = current.status;
          providerRebound = current.provider_reference !== providerTenantReference;
          if (providerRebound) {
            const unresolvedBookings = await client.query({
              name: 'microsoft365-provider-rebind-block-unresolved-bookings',
              text: `
                SELECT 1
                FROM booking_provider_references
                WHERE tenant_id = $1
                  AND integration_id = $2
                  AND state <> 'cancelled'
                LIMIT 1
                FOR UPDATE
              `,
              values: [tenantId, id],
            });
            if (unresolvedBookings.rowCount > 0) {
              return Object.freeze({ status: 'booking_reconciliation_required' });
            }
          }
          version = Number(current.connection_version) + 1;
          const preservesVerifiedConnection = !providerRebound
            && ['connected', 'degraded', 'revoked'].includes(current.status);
          nextStatus = preservesVerifiedConnection ? current.status : 'pending';
          if (preservesVerifiedConnection) {
            await client.query({
              name: 'microsoft365-connection-start-reconnect-preserving-health',
              text: `
                UPDATE integrations
                SET connection_version = $3,
                    updated_at = $4
                WHERE tenant_id = $1 AND id = $2
              `,
              values: [tenantId, id, version, createdAt],
            });
          } else {
            await client.query({
              name: 'microsoft365-connection-reset-pending',
              text: `
                UPDATE integrations
                SET provider_reference = $3,
                    status = 'pending',
                    connection_version = $4,
                    connection_reason = NULL,
                    last_verified_at = NULL,
                    places_permission_status = 'unknown',
                    calendars_permission_status = 'unknown',
                    updated_at = $5
                WHERE tenant_id = $1 AND id = $2
              `,
              values: [tenantId, id, providerTenantReference, version, createdAt],
            });
          }
          if (providerRebound) {
            await client.query({
              name: 'microsoft365-room-mappings-invalidate-on-provider-rebind',
              text: `
                UPDATE microsoft365_room_mappings
                SET provider_status = 'missing',
                    updated_at = $3
                WHERE tenant_id = $1
                  AND integration_id = $2
                  AND provider_status <> 'missing'
              `,
              values: [tenantId, id, createdAt],
            });
            await client.query({
              name: 'microsoft365-capability-health-reset-on-provider-rebind',
              text: `
                DELETE FROM microsoft365_capability_health
                WHERE tenant_id = $1 AND integration_id = $2
              `,
              values: [tenantId, id],
            });
          }
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
          nextStatus,
          providerRebound,
        }));
        return Object.freeze({ status: 'pending', integrationId: id, connectionVersion: version });
      });
    },

    async consumeConsent({
      tenantId,
      actorUserId,
      stateHash,
      callbackProviderTenantReference,
      now,
      rejectionAuditEventFor,
    }) {
      assertUuid(tenantId, 'MICROSOFT365_TENANT_ID_INVALID');
      assertUuid(actorUserId, 'MICROSOFT365_ACTOR_ID_INVALID');
      assertHash(stateHash);
      assertNullableProviderTenant(callbackProviderTenantReference);
      assertDate(now, 'MICROSOFT365_NOW_INVALID');
      if (typeof rejectionAuditEventFor !== 'function') {
        throw new TypeError('MICROSOFT365_REJECTION_AUDIT_FACTORY_REQUIRED');
      }
      return withPostgresTransaction(pool, async (client) => {
        await tenantLock(client, tenantId);
        const result = await client.query({
          name: 'microsoft365-consent-lock-for-consume',
          text: `
            SELECT
              consent.id,
              consent.integration_id,
              consent.provider_tenant_reference,
              consent.connection_version,
              consent.expires_at,
              integration.status AS connection_status,
              integration.last_verified_at,
              integration.connection_reason,
              integration.places_permission_status,
              integration.calendars_permission_status
            FROM microsoft365_consent_transactions consent
            JOIN integrations integration
              ON integration.tenant_id = consent.tenant_id
             AND integration.id = consent.integration_id
            WHERE consent.tenant_id = $1
              AND consent.actor_user_id = $2
              AND consent.state_hash = $3
            FOR UPDATE OF consent, integration
          `,
          values: [tenantId, actorUserId, stateHash],
        });
        const row = result.rows[0];
        if (!row) {
          await appendAudit(client, auditRepository, rejectionAuditEventFor({
            integrationId: null,
            previousStatus: null,
            reasonCode: 'consent_unavailable',
          }));
          return Object.freeze({ status: 'rejected', reason: 'consent_unavailable' });
        }

        let rejectionReason = null;
        if (row.expires_at <= now) {
          rejectionReason = 'consent_expired';
        } else if (
          callbackProviderTenantReference !== null
          && callbackProviderTenantReference !== row.provider_tenant_reference
        ) {
          rejectionReason = 'provider_tenant_mismatch';
        } else {
          const activeBinding = await client.query({
            name: 'microsoft365-lock-active-binding-for-consent',
            text: `
              SELECT 1
              FROM tenant_identity_bindings
              WHERE tenant_id = $1
                AND provider = '${IDENTITY_PROVIDER}'
                AND provider_tenant_reference = $2
                AND status = 'active'
              FOR SHARE
            `,
            values: [tenantId, row.provider_tenant_reference],
          });
          if (activeBinding.rowCount !== 1) rejectionReason = 'provider_binding_mismatch';
        }

        await client.query({
          name: 'microsoft365-consent-delete-consumed',
          text: 'DELETE FROM microsoft365_consent_transactions WHERE id = $1',
          values: [row.id],
        });
        if (rejectionReason !== null) {
          await appendAudit(client, auditRepository, rejectionAuditEventFor({
            integrationId: row.integration_id,
            previousStatus: row.connection_status,
            reasonCode: rejectionReason,
          }));
          return Object.freeze({ status: 'rejected', reason: rejectionReason });
        }
        return Object.freeze({
          status: 'consumed',
          integrationId: row.integration_id,
          providerTenantReference: row.provider_tenant_reference,
          connectionVersion: Number(row.connection_version),
          connectionStatus: row.connection_status,
          lastVerifiedAt: row.last_verified_at,
          connectionReason: row.connection_reason ?? null,
          placesPermission: row.places_permission_status,
          calendarsPermission: row.calendars_permission_status,
        });
      });
    },

    async finalizeConsent({
      tenantId,
      integrationId,
      providerTenantReference,
      connectionVersion,
      status,
      placesPermission,
      calendarsPermission,
      reason,
      lastVerifiedAt,
      changedAt,
      auditEvents = [],
      bindingUnavailableAuditEvent = null,
    }) {
      assertUuid(tenantId, 'MICROSOFT365_TENANT_ID_INVALID');
      assertUuid(integrationId, 'MICROSOFT365_INTEGRATION_ID_INVALID');
      assertProviderTenant(providerTenantReference);
      if (!Number.isSafeInteger(connectionVersion) || connectionVersion < 1) {
        throw new TypeError('MICROSOFT365_VERSION_INVALID');
      }
      const normalizedStatus = normalizeStatus(status);
      const normalizedPlaces = normalizePermission(
        placesPermission,
        PLACES_PERMISSION,
        'MICROSOFT365_PLACES_PERMISSION_INVALID',
      );
      const normalizedCalendars = normalizePermission(
        calendarsPermission,
        CALENDARS_PERMISSION,
        'MICROSOFT365_CALENDARS_PERMISSION_INVALID',
      );
      const normalizedReason = normalizeReason(reason);
      assertNullableDate(lastVerifiedAt, 'MICROSOFT365_VERIFIED_AT_INVALID');
      assertDate(changedAt, 'MICROSOFT365_CHANGED_AT_INVALID');
      if (lastVerifiedAt && lastVerifiedAt > changedAt) {
        throw new TypeError('MICROSOFT365_VERIFIED_AT_INVALID');
      }
      if (!Array.isArray(auditEvents) || auditEvents.length > 3) {
        throw new TypeError('MICROSOFT365_AUDIT_EVENTS_INVALID');
      }

      return withPostgresTransaction(pool, async (client) => {
        await tenantLock(client, tenantId);
        const activeBinding = await client.query({
          name: 'microsoft365-lock-active-binding-for-finalize',
          text: `
            SELECT 1
            FROM tenant_identity_bindings
            WHERE tenant_id = $1
              AND provider = '${IDENTITY_PROVIDER}'
              AND provider_tenant_reference = $2
              AND status = 'active'
            FOR SHARE
          `,
          values: [tenantId, providerTenantReference],
        });
        if (activeBinding.rowCount !== 1) {
          await appendAudit(client, auditRepository, bindingUnavailableAuditEvent);
          return Object.freeze({ status: 'binding_unavailable' });
        }
        const updated = await client.query({
          name: 'microsoft365-connection-finalize',
          text: `
            UPDATE integrations
            SET status = $4,
                connection_version = connection_version + 1,
                places_permission_status = $5,
                calendars_permission_status = $6,
                connection_reason = $7,
                last_verified_at = $8,
                updated_at = $9
            WHERE tenant_id = $1
              AND id = $2
              AND provider = '${PROVIDER}'
              AND connection_version = $3
              AND provider_reference = $10
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
            lastVerifiedAt,
            changedAt,
            providerTenantReference,
          ],
        });
        if (updated.rowCount !== 1) return Object.freeze({ status: 'stale' });
        await client.query({
          name: 'microsoft365-consent-delete-finalized',
          text: 'DELETE FROM microsoft365_consent_transactions WHERE tenant_id = $1 AND integration_id = $2',
          values: [tenantId, integrationId],
        });
        for (const event of auditEvents) await appendAudit(client, auditRepository, event);
        return Object.freeze({ status: 'updated', connection: mapConnection(updated.rows[0]) });
      });
    },

    async disconnect({ tenantId, changedAt, auditEventFor }) {
      assertUuid(tenantId, 'MICROSOFT365_TENANT_ID_INVALID');
      assertDate(changedAt, 'MICROSOFT365_CHANGED_AT_INVALID');
      if (typeof auditEventFor !== 'function') {
        throw new TypeError('MICROSOFT365_AUDIT_FACTORY_REQUIRED');
      }

      return withPostgresTransaction(pool, async (client) => {
        await tenantLock(client, tenantId);
        const current = await client.query({
          name: 'microsoft365-connection-disconnect-lock',
          text: `
            SELECT
              tenant_id, id, provider_reference, status, connection_version,
              last_verified_at, connection_reason, places_permission_status,
              calendars_permission_status, updated_at
            FROM integrations
            WHERE tenant_id = $1 AND provider = '${PROVIDER}'
            FOR UPDATE
          `,
          values: [tenantId],
        });
        const row = current.rows[0];
        if (!row) return null;
        if (row.status === 'disconnected') return mapConnection(row);

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
                last_verified_at = NULL,
                places_permission_status = 'unknown',
                calendars_permission_status = 'unknown',
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
