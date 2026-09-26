import { isInternalUuid } from '../../domain/identifiers.js';
import { isRequestId } from '../../domain/request.js';
import {
  isProviderConnectionReference,
  isProviderReference,
  isProviderResourceReference,
} from '../../integrations/calendar-contract.js';

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isProviderName(value) {
  return typeof value === 'string' && PROVIDER_PATTERN.test(value);
}

function isCleanupReference(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && isInternalUuid(value.integrationId)
    && isProviderReference(value.providerReference)
    && isProviderConnectionReference(value.providerConnectionReference)
    && isProviderResourceReference(value.providerResourceReference);
}

export function createPostgresMicrosoft365CalendarAuthorityGuard() {
  return Object.freeze({
    async lockCurrent(client, {
      tenantId,
      requestId,
      authority,
      cleanupReference = null,
    } = {}) {
      if (
        !client
        || typeof client.query !== 'function'
        || !isInternalUuid(tenantId)
        || !isRequestId(requestId)
        || !isInternalUuid(authority?.integrationId)
        || !isProviderName(authority?.integrationProvider)
        || !isProviderName(authority?.identityProvider)
        || !isProviderConnectionReference(authority?.providerConnectionReference)
        || typeof authority?.roomId !== 'string'
        || !ROOM_ID_PATTERN.test(authority.roomId)
        || !isProviderResourceReference(authority?.providerResourceReference)
        || typeof authority?.calendarWriteEnabled !== 'boolean'
        || (cleanupReference !== null && !isCleanupReference(cleanupReference))
      ) {
        return false;
      }
      if (authority.calendarWriteEnabled && cleanupReference !== null) return false;
      const result = await client.query({
        name: 'calendar-authority-lock-current',
        text: `
          SELECT 1
          FROM integrations i
          JOIN tenant_identity_bindings b
            ON b.tenant_id = i.tenant_id
           AND b.provider = $5
           AND b.provider_tenant_reference = i.provider_reference
           AND b.status = 'active'
          JOIN microsoft365_room_mappings m
            ON m.tenant_id = i.tenant_id
           AND m.integration_id = i.id
           AND m.room_id = $6
           AND m.resource_address = $7
           AND m.provider_status = 'active'
          WHERE i.tenant_id = $1
            AND i.id = $2
            AND i.provider = $4
            AND i.provider_reference = $3
            AND i.status = 'connected'
          FOR SHARE OF i, b, m
        `,
        values: [
          tenantId,
          authority.integrationId,
          authority.providerConnectionReference,
          authority.integrationProvider,
          authority.identityProvider,
          authority.roomId,
          authority.providerResourceReference,
        ],
      });
      if (result.rowCount !== 1) return false;
      if (!authority.calendarWriteEnabled) {
        const references = await client.query({
          name: 'calendar-authority-lock-write-disabled-booking-references',
          text: `
            SELECT integration_id, provider_reference,
              provider_connection_reference, provider_resource_reference, state
            FROM booking_provider_references
            WHERE tenant_id = $1
              AND request_id = $2
              AND state <> 'cancelled'
            ORDER BY integration_id
            FOR UPDATE
          `,
          values: [tenantId, requestId],
        });
        if (cleanupReference === null) return references.rowCount === 0;
        if (references.rowCount !== 1) return false;
        const [reference] = references.rows;
        return reference.state === 'compensated'
          && reference.integration_id === cleanupReference.integrationId
          && reference.provider_reference === cleanupReference.providerReference
          && reference.provider_connection_reference
            === cleanupReference.providerConnectionReference
          && reference.provider_resource_reference === cleanupReference.providerResourceReference;
      }
      const reference = await client.query({
        name: 'calendar-authority-lock-active-booking-reference',
        text: `
          SELECT 1
          FROM booking_provider_references
          WHERE tenant_id = $1
            AND request_id = $2
            AND integration_id = $3
            AND provider_connection_reference = $4
            AND provider_resource_reference = $5
            AND state = 'active'
          FOR SHARE
        `,
        values: [
          tenantId,
          requestId,
          authority.integrationId,
          authority.providerConnectionReference,
          authority.providerResourceReference,
        ],
      });
      return reference.rowCount === 1;
    },

    async completePreConfirmationCleanup(client, {
      tenantId,
      requestId,
      reference,
      changedAt,
    } = {}) {
      if (
        !client
        || typeof client.query !== 'function'
        || !isInternalUuid(tenantId)
        || !isRequestId(requestId)
        || !isCleanupReference(reference)
        || !(changedAt instanceof Date)
        || !Number.isFinite(changedAt.getTime())
      ) {
        return false;
      }
      const result = await client.query({
        name: 'calendar-authority-complete-pre-confirmation-cleanup',
        text: `
          UPDATE booking_provider_references
          SET state = 'cancelled',
            updated_at = $7
          WHERE tenant_id = $1
            AND request_id = $2
            AND integration_id = $3
            AND provider_reference = $4
            AND provider_connection_reference = $5
            AND provider_resource_reference = $6
            AND state = 'compensated'
        `,
        values: [
          tenantId,
          requestId,
          reference.integrationId,
          reference.providerReference,
          reference.providerConnectionReference,
          reference.providerResourceReference,
          changedAt,
        ],
      });
      return result.rowCount === 1;
    },
  });
}
