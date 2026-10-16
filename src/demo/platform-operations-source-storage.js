import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Agent } from 'node:https';
import { validateNeonStorageConfig } from '../media/neon-storage-config.js';
import { OPERATIONS_SOURCE_KEYS, OPERATIONS_SOURCE_MAX_BYTES } from '../observability/operations-source-contract.js';

const VERSION = /^"[a-f0-9]{32}"$/;

export function createOperationsSourceStorage(config, {
  clientFactory = (options) => new S3Client(options), writable = false,
} = {}) {
  const settings = validateNeonStorageConfig(config);
  if (settings.bucket !== 'conference-manager-media' || typeof writable !== 'boolean') {
    throw new TypeError('OPERATIONS_SOURCE_STORAGE_INVALID');
  }
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });
  const client = clientFactory({ endpoint: settings.endpoint, region: settings.region,
    forcePathStyle: true, followRegionRedirects: false, maxAttempts: 1,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    requestHandler: { connectionTimeout: 1000, requestTimeout: 5000, throwOnRequestTimeout: true, httpsAgent: agent },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  let busy = false;
  let closed = false;
  function key(kind) {
    if (!Object.hasOwn(OPERATIONS_SOURCE_KEYS, kind)) throw new TypeError('OPERATIONS_SOURCE_KIND_INVALID');
    return OPERATIONS_SOURCE_KEYS[kind];
  }
  async function execute(command, consume) {
    if (busy || closed) throw new Error('OPERATIONS_SOURCE_UNAVAILABLE');
    busy = true;
    const controller = new AbortController();
    let body;
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort(); body?.destroy?.(); reject(new Error('OPERATIONS_SOURCE_UNAVAILABLE'));
          }, 5000);
        }),
        (async () => {
          const result = await client.send(command, { abortSignal: controller.signal });
          body = result?.Body;
          if (controller.signal.aborted) throw new Error('OPERATIONS_SOURCE_UNAVAILABLE');
          return consume(result, controller.signal);
        })(),
      ]);
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 412 || error?.name === 'PreconditionFailed') {
        throw new Error('OPERATIONS_SOURCE_CONFLICT');
      }
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey') return null;
      throw new Error('OPERATIONS_SOURCE_UNAVAILABLE');
    } finally { clearTimeout(timer); body?.destroy?.(); busy = false; }
  }
  return Object.freeze({
    async read(kind) {
      return execute(new GetObjectCommand({ Bucket: settings.bucket, Key: key(kind) }), async (result, signal) => {
        if (result.ContentType !== 'application/json' || !VERSION.test(result.ETag)
          || !Number.isSafeInteger(result.ContentLength) || result.ContentLength < 1
          || result.ContentLength > OPERATIONS_SOURCE_MAX_BYTES || !result.Body?.[Symbol.asyncIterator]) {
          throw new Error('OPERATIONS_SOURCE_UNAVAILABLE');
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of result.Body) {
          if (signal.aborted || (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))) throw new Error('INVALID');
          size += chunk.length;
          if (size > result.ContentLength) throw new Error('INVALID');
          chunks.push(Buffer.from(chunk));
        }
        if (signal.aborted || size !== result.ContentLength) throw new Error('INVALID');
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)), version: result.ETag };
      });
    },
    async write(kind, text, expectedVersion) {
      const objectKey = key(kind);
      if (!writable || typeof text !== 'string' || Buffer.byteLength(text) < 1
        || Buffer.byteLength(text) > OPERATIONS_SOURCE_MAX_BYTES
        || (expectedVersion !== null && !VERSION.test(expectedVersion))) throw new TypeError('OPERATIONS_SOURCE_WRITE_INVALID');
      const result = await execute(new PutObjectCommand({ Bucket: settings.bucket, Key: objectKey,
        Body: text, ContentType: 'application/json', ContentLength: Buffer.byteLength(text),
        ...(expectedVersion === null ? { IfNoneMatch: '*' } : { IfMatch: expectedVersion }),
      }), (value) => {
        if (!VERSION.test(value.ETag)) throw new Error('OPERATIONS_SOURCE_UNAVAILABLE');
        return { version: value.ETag };
      });
      if (!result) throw new Error('OPERATIONS_SOURCE_UNAVAILABLE');
      return result;
    },
    close() { closed = true; client.destroy(); agent.destroy(); },
  });
}
