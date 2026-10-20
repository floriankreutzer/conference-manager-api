import { ApiError } from '../../api-error.js';
import { PlatformHttpError } from './errors.js';
import {
  assertPlatformMethod,assertPlatformRequestHost,assertPlatformRequestOrigin,
  assertPlatformRequestTarget,isPlatformUnsafeMethod,
} from './security.js';

const EXCLUSIVE_COMPLETIONS=new Set([
  '/api/v1/platform/synthetic/generation/replace',
  '/api/v1/platform/auth/delegation/approve',
]);

// Transport-only adapter, fixed at the owned Platform composition. This is no
// authority to execute the operation: both handlers still require exact proof.
export const protectedPlatformExecutionBoundary=Object.freeze({
  validate(request,origin) {
    assertPlatformMethod(request.method);assertPlatformRequestTarget(request.url);
    assertPlatformRequestHost(request.headers,origin);
    assertPlatformRequestOrigin(request.headers,origin,{ required: isPlatformUnsafeMethod(request.method) });
  },
  ownsExclusiveCompletion: path=>EXCLUSIVE_COMPLETIONS.has(path),
  mapError: error=>error instanceof PlatformHttpError ? new ApiError(error.statusCode,error.code) : error,
});
