import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const bytes = Buffer.from('bounded transport fixture');

async function startS3Fixture(t, complete) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'image/webp', 'content-length': String(bytes.length) });
    if (complete) response.end(bytes);
    else response.write(bytes.subarray(0, 2));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const client = new S3Client({ endpoint: `http://127.0.0.1:${server.address().port}`,
    region: 'eu-central-1', forcePathStyle: true, maxAttempts: 1, followRegionRedirects: false,
    credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-material-only' },
    requestHandler: { connectionTimeout: 1000, requestTimeout: 1000, socketTimeout: 300,
      throwOnRequestTimeout: true },
    responseChecksumValidation: 'WHEN_REQUIRED' });
  t.after(() => client.destroy());
  const response = await client.send(new GetObjectCommand({ Bucket: 'private-media', Key: 'fixture' }),
    { abortSignal: AbortSignal.timeout(3000) });
  return { body: response.Body, requestCount: () => requests };
}

test('installed S3 transport aborts a stalled body after receiving successful headers', { timeout: 5000 }, async t => {
  const fixture = await startS3Fixture(t, false);
  await assert.rejects(fixture.body.transformToByteArray(), { name: 'TimeoutError' });
  assert.equal(fixture.body.destroyed, true);
  assert.equal(fixture.requestCount(), 1);
});

test('installed S3 transport preserves a complete bounded response body', { timeout: 5000 }, async t => {
  const fixture = await startS3Fixture(t, true);
  assert.deepEqual(Buffer.from(await fixture.body.transformToByteArray()), bytes);
  assert.equal(fixture.requestCount(), 1);
});
