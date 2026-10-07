import { createCustomerComposition } from '../../src/customer-composition.js';
import { createLogger } from '../../src/logger.js';

// Construct every production service while forbidding all external-provider work in this read baseline.
export function createSessionLoadRuntime({ config, persistence }) {
  const microsoft365Client = Object.freeze(Object.fromEntries([
    'lookupFreeBusy', 'verifyBasePermissions', 'adminConsentUrl', 'discoverRooms',
    'createCalendarEvent', 'updateCalendarEvent', 'cancelCalendarEvent',
  ].map((name) => [name, () => { throw new Error('LOAD_PROVIDER_OPERATION_FORBIDDEN'); }])));
  return createCustomerComposition({ config, persistence, microsoft365Client, logger: createLogger({ write() {} }) });
}
