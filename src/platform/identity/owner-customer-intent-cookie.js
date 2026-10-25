import { createPlatformCustomerHandoffIntentCookie } from './customer-handoff-intent-cookie.js';

export const PLATFORM_OWNER_INTENT_COOKIE='cm_platform_owner_intent';
export function createPlatformOwnerCustomerIntentCookie(options={}) {
  return createPlatformCustomerHandoffIntentCookie({ ...options,kind: 'owner_real' });
}
