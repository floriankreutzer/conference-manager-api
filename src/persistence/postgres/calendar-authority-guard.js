import { isInternalUuid } from '../../domain/identifiers.js';
import { isRequestId } from '../../domain/request.js';
import {
  isProviderConnectionReference,
  isProviderResourceReference,
} from '../../integrations/calendar-contract.js';

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isProviderName(value) {
  return typeof value === 'string' && PROVIDER_PATTERN.test(value);
}

export function createPostgresMicrosoft365CalendarAuthorityGuard() {
  return Object.freeze({
    async lockCurrent(client, { tenantId, requestId, authority } = {}) {
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
      ) {
        return false;
      }
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
            AND (
              $8::boolean
              OR NOT EXISTS (
                SELECT 1
                FROM booking_provider_references booking
                WHERE booking.tenant_id = $1
                  AND booking.request_id = $9
                  AND booking.state <> 'cancelled'
              )
            )
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
          authority.calendarWriteEnabled,
          requestId,
        ],
      });
      return result.rowCount === 1;
    },
  });
}
