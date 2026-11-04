import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Agent } from 'node:https';
import { validateNeonStorageConfig } from '../media/neon-storage-config.js';

export const LIVE_METRICS_OBJECT_KEY = 'operations/metrics/daily-v1.json';
const MAX_BYTES = 48_000;

// Read-only and fixed key: this port cannot address Tenant media, list objects or write data.
export function createLiveMetricsStorage(config, { clientFactory = (options) => new S3Client(options) } = {}) {
  const settings = validateNeonStorageConfig(config);
  if (settings.bucket !== 'conference-manager-media') throw new TypeError('LIVE_METRICS_STORAGE_INVALID');
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });
  const client = clientFactory({ endpoint: settings.endpoint, region: settings.region,
    forcePathStyle: true, followRegionRedirects: false, maxAttempts: 1,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    requestHandler: { connectionTimeout: 1000, requestTimeout: 5000, throwOnRequestTimeout: true, httpsAgent: agent },
    responseChecksumValidation: 'WHEN_REQUIRED' });
  let closed = false;
  let busy = false;
  return Object.freeze({
    async read() {
      if (closed || busy) throw new Error('LIVE_METRICS_STORAGE_UNAVAILABLE');
      busy = true;
      const controller = new AbortController();
      let body;
      let timer;
      const expired = new Promise((resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); body?.destroy?.(); reject(new Error('LIVE_METRICS_STORAGE_UNAVAILABLE')); }, 5000);
      });
      try {
        return await Promise.race([expired, (async () => {
          const result = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: LIVE_METRICS_OBJECT_KEY }),
            { abortSignal: controller.signal });
          body = result?.Body;
          if (controller.signal.aborted || result.ContentType !== 'application/json'
            || !Number.isSafeInteger(result.ContentLength) || result.ContentLength < 1
            || result.ContentLength > MAX_BYTES || !body?.[Symbol.asyncIterator]) throw new Error('INVALID');
          const chunks = [];
          let size = 0;
          for await (const chunk of body) {
            if (controller.signal.aborted || (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))) throw new Error('INVALID');
            size += chunk.length;
            if (size > MAX_BYTES || size > result.ContentLength) throw new Error('INVALID');
            chunks.push(Buffer.from(chunk));
          }
          if (controller.signal.aborted || size !== result.ContentLength) throw new Error('INVALID');
          return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
        })()]);
      } catch { throw new Error('LIVE_METRICS_STORAGE_UNAVAILABLE'); }
      finally { clearTimeout(timer); body?.destroy?.(); busy = false; }
    },
    close() { closed = true; client.destroy(); agent.destroy(); },
  });
}
