import { createPlatformCustomerHandoffIntentCookie } from './customer-handoff-intent-cookie.js';

export const PLATFORM_SYNTHETIC_INTENT_COOKIE='cm_platform_synthetic_intent';
export function createPlatformSyntheticHandoffIntentCookie(options={}) {
  return createPlatformCustomerHandoffIntentCookie({ ...options,kind: 'synthetic' });
}
