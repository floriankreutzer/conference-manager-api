import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Agent } from 'node:https';
import { mediaObjectReference, verifyMediaObjectBytes, MediaObjectStorageError } from './object-storage-contract.js';

const ENDPOINT = /^https:\/\/br-[a-z0-9-]+\.storage\.c-5\.eu-central-1\.aws\.neon\.tech$/;
const DEADLINE_MS = 5000;
const MAX_IN_FLIGHT = 8;

export function validateNeonStorageConfig(config) {
  if (!config || !ENDPOINT.test(config.endpoint) || config.region !== 'eu-central-1'
    || typeof config.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)
    || typeof config.accessKeyId !== 'string' || config.accessKeyId.length < 8 || config.accessKeyId.length > 256
    || typeof config.secretAccessKey !== 'string' || config.secretAccessKey.length < 16
    || config.secretAccessKey.length > 512 || /[\s\x00-\x1f]/.test(config.accessKeyId + config.secretAccessKey)) {
    throw new TypeError('MEDIA_STORAGE_CONFIG_INVALID');
  }
  return Object.freeze({ ...config });
}

function safeFailure(error) {
  if (error instanceof MediaObjectStorageError) return error;
  if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey') {
    return new MediaObjectStorageError('MEDIA_STORAGE_OBJECT_MISSING');
  }
  return new MediaObjectStorageError();
}

export function createNeonObjectStorage(config, { clientFactory = (options) => new S3Client(options) } = {}) {
  const settings = validateNeonStorageConfig(config);
  const agent = new Agent({ keepAlive: true, maxSockets: MAX_IN_FLIGHT, maxTotalSockets: MAX_IN_FLIGHT });
  const client = clientFactory({ endpoint: settings.endpoint, region: settings.region,
    forcePathStyle: true, followRegionRedirects: false, maxAttempts: 1,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    requestHandler: { connectionTimeout: 1000, requestTimeout: DEADLINE_MS,
      throwOnRequestTimeout: true, httpsAgent: agent },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  let inFlight = 0;
  let closed = false;

  async function execute(command, consume = (value) => value) {
    if (closed || inFlight >= MAX_IN_FLIGHT) throw new MediaObjectStorageError();
    inFlight += 1;
    const controller = new AbortController();
    let body;
    let timeout;
    const expired = new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        body?.destroy?.();
        reject(new MediaObjectStorageError());
      }, DEADLINE_MS);
    });
    try {
      return await Promise.race([expired, (async () => {
        const result = await client.send(command, { abortSignal: controller.signal });
        body = result?.Body;
        if (controller.signal.aborted) { body?.destroy?.(); throw new MediaObjectStorageError(); }
        return consume(result, controller.signal);
      })()]);
    } catch (error) {
      throw safeFailure(error);
    } finally {
      clearTimeout(timeout);
      body?.destroy?.();
      inFlight -= 1;
    }
  }

  return Object.freeze({
    async put(input, bytes) {
      const reference = mediaObjectReference(input);
      verifyMediaObjectBytes(bytes, reference);
      await execute(new PutObjectCommand({ Bucket: settings.bucket, Key: reference.key,
        Body: bytes, ContentLength: reference.byteLength, ContentType: reference.contentType }));
      return reference.key;
    },
    async get(input) {
      const reference = mediaObjectReference(input);
      return execute(new GetObjectCommand({ Bucket: settings.bucket, Key: reference.key }), async (result, signal) => {
        if (result.ContentLength !== reference.byteLength || result.ContentType !== reference.contentType
          || !result.Body?.[Symbol.asyncIterator]) throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
        const chunks = [];
        let length = 0;
        for await (const chunk of result.Body) {
          if (signal.aborted || (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))) {
            throw new MediaObjectStorageError();
          }
          length += chunk.length;
          if (length > reference.byteLength) throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
          chunks.push(Buffer.from(chunk));
        }
        if (signal.aborted) throw new MediaObjectStorageError();
        return verifyMediaObjectBytes(Buffer.concat(chunks, length), reference);
      });
    },
    async remove(input) {
      const reference = mediaObjectReference(input);
      await execute(new DeleteObjectCommand({ Bucket: settings.bucket, Key: reference.key }));
    },
    close() { closed = true; client.destroy(); agent.destroy(); },
  });
}
