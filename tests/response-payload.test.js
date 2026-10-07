import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import { observeResponsePayloadSafely } from '../src/observability/response-payload.js';

function response({ length = 10, type = 'application/json; charset=utf-8', statusCode = 200, finished = false } = {}) {
  const value = new EventEmitter();
  value.statusCode = statusCode;
  value.writableFinished = finished;
  value.getHeader = (key) => key === 'Content-Length' ? length : type;
  return value;
}

function observe(value, metrics = createMetricsRegistry(), method = 'GET') {
  observeResponsePayloadSafely({ response: value, metrics, route: 'request', method });
  return metrics;
}

test('framed response payload is counted once after finish using only fixed dimensions', () => {
  const value = response();
  const metrics = observe(value);
  assert.deepEqual(metrics.snapshot().counters, []);
  value.emit('finish');
  value.emit('finish');
  const counters = metrics.snapshot().counters;
  assert.equal(counters.find(({ metric }) => metric === 'api_response_payload_bytes_total').value, 10);
  assert.equal(counters.find(({ metric }) => metric === 'api_response_payload_observations_total').value, 1);
  assert.deepEqual(counters[0].labels, { route: 'request', method: 'GET', status: '2xx', payload: 'json' });
});

test('bodyless responses do not count representation length and image MIME stays low-cardinality', () => {
  for (const statusCode of [204, 205, 304]) {
    const metrics = observe(response({ statusCode, length: 999, finished: true }));
    assert.equal(metrics.snapshot().counters[0].value, 0);
    assert.equal(metrics.snapshot().counters[0].labels.payload, 'empty');
  }
  const head = observe(response({ finished: true }), undefined, 'HEAD');
  assert.equal(head.snapshot().counters[0].value, 0);
  assert.equal(head.snapshot().counters[0].labels.method, 'OTHER');
  const image = observe(response({ length: '123', type: 'image/webp', finished: true }));
  assert.equal(image.snapshot().counters[0].value, 123);
  assert.equal(image.snapshot().counters[0].labels.payload, 'image');
});

test('aborted, chunked and malformed responses are not misreported as completed transfer', () => {
  const aborted = response();
  const metrics = observe(aborted);
  aborted.emit('close');
  aborted.emit('finish');
  assert.deepEqual(metrics.snapshot().counters, []);
  for (const length of [undefined, null, -1, '1e3', '01', 'secret', [], Number.MAX_SAFE_INTEGER + 1]) {
    const malformed = response({ finished: true });
    malformed.getHeader = () => length;
    assert.deepEqual(observe(malformed).snapshot().counters, []);
  }
});

test('response observers tolerate missing or failed sinks without accepting unsafe labels', () => {
  assert.doesNotThrow(() => observe(response({ finished: true }), { recordApiRequest() {} }));
  assert.doesNotThrow(() => observe(response({ finished: true }), { recordResponsePayload() { throw new Error('FAIL'); } }));
  const metrics = createMetricsRegistry();
  const sample = { route: 'request', method: 'GET', statusCode: 200, payloadClass: 'json', bytes: 1 };
  for (const patch of [{ route: 'secret-id' }, { payloadClass: 'secret-mime' }, { bytes: NaN }, { bytes: -1 }]) {
    assert.throws(() => metrics.recordResponsePayload({ ...sample, ...patch }), /METRIC_/);
  }
  metrics.recordResponsePayload({ ...sample, bytes: Number.MAX_SAFE_INTEGER });
  assert.throws(() => metrics.recordResponsePayload(sample), /METRIC_COUNTER_OVERFLOW/);
});
