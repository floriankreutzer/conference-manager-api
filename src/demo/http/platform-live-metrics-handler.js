import { handleDemoPrivateProjection } from './platform-private-projection-handler.js';

export const DEMO_LIVE_METRICS_PATH = '/api/v1/platform/demo/live-metrics';

export function handleDemoLiveMetrics({ liveMetrics, ...options }) {
  return handleDemoPrivateProjection({ ...options, projection: liveMetrics,
    path: DEMO_LIVE_METRICS_PATH, unavailableCode: 'PLATFORM_LIVE_METRICS_UNAVAILABLE' });
}
