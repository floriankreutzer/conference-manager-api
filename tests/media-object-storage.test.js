import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { createNeonObjectStorage, validateNeonStorageConfig } from '../src/media/neon-object-storage.js';
import { mediaObjectReference, MediaObjectStorageError } from '../src/media/object-storage-contract.js';

const bytes = Buffer.from('bounded sanitized media');
const reference = { tenantId: '11111111-1111-4111-8111-111111111111',
  assetId: '22222222-2222-4222-8222-222222222222', kind: 'room', contentType: 'image/webp',
  byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const config = { endpoint: 'https://br-test-123.storage.c-5.eu-central-1.aws.neon.tech',
  region: 'eu-central-1', bucket: 'private-media', accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-material-only' };

function setup(response) {
  const calls = [];
  let options;
  const storage = createNeonObjectStorage(config, { clientFactory(value) {
    options = value;
    return { send: async (command, context) => {
      calls.push({ command, context });
      return typeof response === 'function' ? response(command, context) : response;
    }, destroy() {} };
  } });
  return { storage, calls, get options() { return options; } };
}

test('object keys bind tenant, kind, asset and content digest; caller keys are ignored', () => {
  const key = mediaObjectReference({ ...reference, key: '../../other-tenant' }).key;
  assert.equal(key, `v1/${reference.tenantId}/room/${reference.assetId}/${reference.sha256}`);
  assert.notEqual(mediaObjectReference({ ...reference, tenantId: '33333333-3333-4333-8333-333333333333' }).key, key);
  for (const change of [{ tenantId: '../escape' }, { assetId: '../escape' }, { kind: 'unknown' },
    { sha256: 'A'.repeat(64) }, { byteLength: 0 }, { byteLength: 2097153 }, { contentType: 'text/html' }]) {
    assert.throws(() => mediaObjectReference({ ...reference, ...change }), /REFERENCE_INVALID/);
  }
});

test('storage configuration rejects arbitrary destinations, credentials and malformed buckets', () => {
  for (const change of [{ endpoint: 'http://127.0.0.1' }, { endpoint: `${config.endpoint}/redirect` },
    { endpoint: `${config.endpoint}.evil.example` }, { endpoint: 'https://user:secret@br-test.storage.c-5.eu-central-1.aws.neon.tech' },
    { endpoint: `${config.endpoint}?token=secret` }, { region: 'us-east-1' }, { bucket: '../escape' },
    { accessKeyId: 'short' }, { secretAccessKey: 'bad\nsecret-material' }]) {
    assert.throws(() => validateNeonStorageConfig({ ...config, ...change }), /CONFIG_INVALID/);
  }
});

test('adapter pins SigV4 client, path style, deadlines, concurrency and no automatic retry', async () => {
  const state = setup({});
  try {
    await state.storage.put(reference, bytes);
    assert.equal(state.options.maxAttempts, 1);
    assert.equal(state.options.forcePathStyle, true);
    assert.equal(state.options.followRegionRedirects, false);
    assert.equal(state.options.requestHandler.connectionTimeout, 1000);
    assert.equal(state.options.requestHandler.throwOnRequestTimeout, true);
    assert.equal(state.options.requestHandler.httpsAgent.maxSockets, 8);
    assert.deepEqual(state.calls[0].command.input, { Bucket: config.bucket, Key: mediaObjectReference(reference).key,
      Body: bytes, ContentLength: bytes.length, ContentType: 'image/webp' });
    assert.ok(state.calls[0].context.abortSignal instanceof AbortSignal);
    await state.storage.remove(reference);
    assert.equal(state.calls[1].command.constructor.name, 'DeleteObjectCommand');
  } finally { state.storage.close(); }
});

test('reads verify streamed size, type and digest before returning any bytes', async () => {
  const state = setup({ Body: Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]),
    ContentLength: bytes.length, ContentType: 'image/webp' });
  try { assert.deepEqual(await state.storage.get(reference), bytes); }
  finally { state.storage.close(); }
});

test('truncated, oversized, changed and wrong-type objects fail closed and destroy streams', async () => {
  for (const response of [{ chunks: [bytes.subarray(1)] }, { chunks: [bytes, bytes] },
    { chunks: [Buffer.alloc(bytes.length)] }, { chunks: [bytes], ContentType: 'text/html' },
    { chunks: [bytes], ContentLength: bytes.length + 1 }]) {
    const body = Readable.from(response.chunks);
    const state = setup({ ContentLength: bytes.length, ContentType: 'image/webp', ...response, Body: body });
    try {
      await assert.rejects(state.storage.get(reference), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
      assert.equal(body.destroyed, true);
    } finally { state.storage.close(); }
  }
});

test('invalid uploads make no provider call and provider errors never expose secrets', async () => {
  const state = setup(() => { throw new Error('secret-token/private-provider-body'); });
  try {
    await assert.rejects(state.storage.put(reference, Buffer.from('bad')), MediaObjectStorageError);
    assert.equal(state.calls.length, 0);
    await assert.rejects(state.storage.get(reference), (error) => {
      assert.equal(error.message, 'MEDIA_STORAGE_UNAVAILABLE');
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes('secret-token'), false);
      return true;
    });
  } finally { state.storage.close(); }
});

test('missing objects are distinguished without falling back; closed adapters fail before I/O', async () => {
  const state = setup(() => { throw { name: 'NoSuchKey', message: 'sensitive' }; });
  await assert.rejects(state.storage.get(reference), { code: 'MEDIA_STORAGE_OBJECT_MISSING' });
  state.storage.close();
  await assert.rejects(state.storage.get(reference), { code: 'MEDIA_STORAGE_UNAVAILABLE' });
  assert.equal(state.calls.length, 1);
});

test('whole-operation deadline aborts a stalled response stream', async () => {
  let signal;
  const body = new Readable({ read() {} });
  const state = setup((command, context) => {
    signal = context.abortSignal;
    return { Body: body, ContentLength: bytes.length, ContentType: 'image/webp' };
  });
  try {
    await assert.rejects(state.storage.get(reference), { code: 'MEDIA_STORAGE_UNAVAILABLE' });
    assert.equal(signal.aborted, true);
    assert.equal(body.destroyed, true);
  } finally { state.storage.close(); }
});

test('parallel requests are bounded without an unbounded waiting queue', async () => {
  const state = setup(() => new Promise(() => {}));
  const requests = Array.from({ length: 8 }, () => state.storage.get(reference));
  try {
    await assert.rejects(state.storage.get(reference), { code: 'MEDIA_STORAGE_UNAVAILABLE' });
    assert.equal(state.calls.length, 8);
    const results = await Promise.allSettled(requests);
    assert.ok(results.every((result) => result.status === 'rejected'));
  } finally { state.storage.close(); }
});

test('real SDK signs only the fixed endpoint and neither follows redirects nor retries service failures', async () => {
  for (const statusCode of [301, 302, 307, 503]) {
    const calls = [];
    const storage = createNeonObjectStorage(config, { clientFactory: (options) => new S3Client({ ...options,
      requestHandler: { destroy() {}, async handle(request) {
        calls.push(request);
        return { response: { statusCode, headers: { location: 'http://127.0.0.1/internal',
          'content-type': 'application/xml', 'x-amz-bucket-region': 'us-east-1' },
        body: Readable.from(['<Error><Code>ServiceUnavailable</Code><Message>secret-provider-body</Message></Error>']) } };
      } },
    }) });
    try {
      await assert.rejects(storage.get(reference), { code: 'MEDIA_STORAGE_UNAVAILABLE' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].hostname, new URL(config.endpoint).hostname);
      assert.equal(calls[0].protocol, 'https:');
      assert.equal(calls[0].path, `/${config.bucket}/${mediaObjectReference(reference).key}`);
      assert.match(calls[0].headers.authorization, /^AWS4-HMAC-SHA256 /);
    } finally { storage.close(); }
  }
});
