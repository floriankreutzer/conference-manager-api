import { protectPlatformExactOperationRoute } from './exact-operation-route.js';

// Legacy profile remains fixed for existing callers and retained proof history.
export function protectPlatformPasskeyRoute(module,options={}) {
  return protectPlatformExactOperationRoute(module,{ ...options,mode: 'application_passkey' });
}
