import { createCustomerComposition } from '../../src/customer-composition.js';
import { createLogger } from '../../src/logger.js';

// Construct production services; all writes and real external-provider work remain forbidden.
export function createSessionLoadRuntime({ config, persistence, lookupFreeBusy }) {
  if (lookupFreeBusy !== undefined && typeof lookupFreeBusy !== 'function') throw new Error('LOAD_PROVIDER_FIXTURE_INVALID');
  const microsoft365Client = Object.freeze(Object.fromEntries([
    'lookupFreeBusy', 'verifyBasePermissions', 'adminConsentUrl', 'discoverRooms',
    'createCalendarEvent', 'updateCalendarEvent', 'cancelCalendarEvent',
  ].map((name) => [name, name === 'lookupFreeBusy' && lookupFreeBusy ? lookupFreeBusy
    : () => { throw new Error('LOAD_PROVIDER_OPERATION_FORBIDDEN'); }])));
  return createCustomerComposition({ config, persistence, microsoft365Client, logger: createLogger({ write() {} }) });
}
