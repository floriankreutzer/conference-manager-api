import { exactKeys, liveMediaFail, requireLiveMedia } from './live-media-operator-config.mjs';

export async function assertLiveRuntimesClosed(fetcher = fetch) {
  for (const [origin, prefix] of [
    ['https://conference-manager-demo.onrender.com', '/api/v1'],
    ['https://conference-manager-ops-demo.onrender.com', '/api/v1/platform'],
  ]) {
    for (const [path, status] of [['/health/deploy', 200], ['/health/ready', 503], ['/demo/session', 503]]) {
      let response;
      try {
        response = await fetcher(origin + prefix + path, { method: 'GET', redirect: 'error',
          signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
        requireLiveMedia(response.status === status && response.redirected === false
          && /^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')
          && response.body?.[Symbol.asyncIterator], 'LIVE_MEDIA_RUNTIME_NOT_CLOSED');
        let length = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          length += chunk.length;
          requireLiveMedia(length <= 1024, 'LIVE_MEDIA_RUNTIME_NOT_CLOSED');
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        requireLiveMedia(typeof body?.requestId === 'string' && body.requestId.length <= 128
          && (status === 200
            ? exactKeys(body, ['status', 'trafficMode', 'requestId'])
              && body.status === 'deployment_ready' && body.trafficMode === 'closed'
            : exactKeys(body, ['error', 'requestId']) && exactKeys(body.error, ['code'])
              && body.error.code === 'DEMO_TRAFFIC_CLOSED'), 'LIVE_MEDIA_RUNTIME_NOT_CLOSED');
      } catch { liveMediaFail('LIVE_MEDIA_RUNTIME_NOT_CLOSED'); }
      finally { try { await response?.body?.cancel(); } catch { /* Never retain response bodies or request IDs. */ } }
    }
  }
}
