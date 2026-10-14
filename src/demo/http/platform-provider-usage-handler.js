import { handleDemoPrivateProjection } from './platform-private-projection-handler.js';

export const DEMO_PROVIDER_USAGE_PATH = '/api/v1/platform/demo/provider-usage';

export function handleDemoProviderUsage({ providerUsage, ...options }) {
  return handleDemoPrivateProjection({ ...options, projection: providerUsage,
    path: DEMO_PROVIDER_USAGE_PATH, unavailableCode: 'PLATFORM_PROVIDER_USAGE_UNAVAILABLE' });
}
