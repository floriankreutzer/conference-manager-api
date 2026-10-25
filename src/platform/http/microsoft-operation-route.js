import { protectPlatformExactOperationRoute } from './exact-operation-route.js';

export function protectPlatformMicrosoftRoute(module,options={}) {
  return protectPlatformExactOperationRoute(module,{ ...options,mode: 'microsoft_mfa' });
}
