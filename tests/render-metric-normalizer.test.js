import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRenderMetric, renderMetricQuery } from '../scripts/support/render-metric-normalizer.mjs';
import { LIVE_METRICS, normalizeLiveMeasurements } from '../src/observability/live-metrics-contract.js';

const QUERIED = '2026-10-18T12:43:02.000Z';
const OBSERVED = '2026-10-18T12:43:05.000Z';
const memory = (series) => ({ surface: 'customer', metricType: 'memory_usage', queriedAt: QUERIED,
  observedAt: OBSERVED, response: { metrics: [{ type: 'memory_usage', data: series }] } });
const row = (timestamp, value) => ({ timestamp, value });

test('fine Render memory queries retain genuine point and query clocks across old instance series', () => {
  const query = renderMetricQuery('memory_usage', QUERIED);
  assert.deepEqual(query, { metricTypes: ['memory_usage'], resolution: 300,
    startTime: '2026-10-17T12:43:02.000Z', endTime: QUERIED });
  const input = memory([
    { labels: { instance: 'synthetic-old' }, unit: 'bytes', values: [row('2026-10-18T09:00:00Z', 41)] },
    { labels: { instance: 'synthetic-new' }, unit: 'bytes', values: [row('2026-10-18T12:40:00Z', 67)] },
  ]);
  const result = normalizeRenderMetric(input);
  assert.equal(result.reason, null);
  assert.deepEqual(result.measurement, { id: 'render_customer_memory', value: 67,
    observedAt: OBSERVED, periodStart: query.startTime, periodEnd: QUERIED, sampleAt: '2026-10-18T12:40:00.000Z' });
  assert.ok(!JSON.stringify(result).includes('synthetic-'));
  const measurements = Object.keys(LIVE_METRICS).map((id) => id === result.measurement.id ? result.measurement
    : { id, value: null, observedAt: null, periodStart: null, periodEnd: null, sampleAt: null });
  assert.deepEqual(normalizeLiveMeasurements(measurements, OBSERVED), measurements);
});

test('empty, excessive, malformed or latest-conflicting Render data never becomes fabricated memory or zero', () => {
  for (const series of [[], [{ unit: 'bytes', values: [] }],
    [{ unit: 'mb', values: [row('2026-10-18T12:40:00Z', 1)] }],
    [{ unit: 'bytes', values: [row('2026-10-18T12:40:00Z', 1), row('2026-10-18T12:40:00Z', 2)] }],
    [{ unit: 'bytes', values: [row('2026-10-18T12:45:00Z', 1)] }],
    [{ unit: 'bytes', values: [row('2026-10-17T12:40:00Z', 1)] }],
    [{ unit: 'bytes', values: [row('2026-10-18T12:40:00Z', 1.5)] }],
    [{ unit: 'bytes', values: [row('2026-10-18T12:40:00Z', Infinity)] }],
    [{ unit: 'bytes', values: Array.from({ length: 2001 }, () => row('2026-10-18T12:40:00Z', 1)) }],
    Array.from({ length: 33 }, () => ({ unit: 'bytes', values: [] })),
  ]) {
    const result = normalizeRenderMetric(memory(series));
    assert.ok(result.reason);
    assert.deepEqual(result.measurement, { id: 'render_customer_memory', value: null,
      observedAt: null, periodStart: null, periodEnd: null, sampleAt: null });
  }
  const duplicate = memory([{ unit: 'bytes', values: [row('2026-10-18T12:40:00Z', 1)] }]);
  duplicate.response.metrics.push(structuredClone(duplicate.response.metrics[0]));
  assert.equal(normalizeRenderMetric(duplicate).measurement.value, null);
});

test('only conflicts at the final memory timestamp matter and observed zero remains an explicit value', () => {
  const result = normalizeRenderMetric(memory([{ unit: 'bytes', values: [
    row('2026-10-18T11:00:00Z', 1), row('2026-10-18T11:00:00Z', 2),
    row('2026-10-18T12:40:00Z', 0), row('2026-10-18T12:40:00Z', 0),
  ] }]));
  assert.equal(result.measurement.value, 0);
  assert.equal(result.reason, null);
});

test('Render bandwidth retains the completed hourly window, single series and no summation', () => {
  const query = renderMetricQuery('bandwidth_usage', QUERIED);
  assert.deepEqual(query, { metricTypes: ['bandwidth_usage'], resolution: 3600,
    startTime: '2026-10-17T12:00:00.000Z', endTime: '2026-10-18T12:00:00.000Z' });
  const input = { surface: 'operations', metricType: 'bandwidth_usage', queriedAt: QUERIED,
    observedAt: OBSERVED, response: { metrics: [{ type: 'bandwidth_usage',
      data: [{ unit: 'mb', values: [row('2026-10-18T10:00:00Z', 3), row('2026-10-18T11:00:00Z', 2.5)] }] }] } };
  assert.equal(normalizeRenderMetric(input).measurement.value, 2.5);
  input.response.metrics[0].data.push(structuredClone(input.response.metrics[0].data[0]));
  assert.equal(normalizeRenderMetric(input).measurement.value, null);
  input.response.metrics[0].data.pop();
  input.queriedAt = '2026-10-18T11:59:59.000Z'; input.observedAt = '2026-10-18T12:00:01.000Z';
  assert.equal(normalizeRenderMetric(input).reason, 'query_window_changed');
});

test('fine memory windows accept original hourly snapshots and reject displaced or invented windows', () => {
  const rows = Object.keys(LIVE_METRICS).map((id) => ({ id, value: null,
    observedAt: null, periodStart: null, periodEnd: null, sampleAt: null }));
  const sample = rows.find((item) => item.id === 'render_operations_memory');
  Object.assign(sample, { value: 60, observedAt: OBSERVED, periodStart: '2026-10-17T12:00:00.000Z',
    periodEnd: '2026-10-18T12:00:00.000Z', sampleAt: '2026-10-18T11:55:00.000Z' });
  assert.equal(normalizeLiveMeasurements(rows, OBSERVED).find((item) => item.id === sample.id).value, 60);
  for (const change of [{ periodStart: '2026-10-16T12:00:00.000Z' },
    { periodEnd: '2026-10-18T12:44:00.000Z' }, { sampleAt: OBSERVED }]) {
    const altered = structuredClone(rows);
    Object.assign(altered.find((item) => item.id === sample.id), change);
    assert.throws(() => normalizeLiveMeasurements(altered, OBSERVED));
  }
  assert.throws(() => normalizeRenderMetric({ ...memory([]), surface: 'tenant-selected' }));
  assert.throws(() => normalizeRenderMetric({ ...memory([]), observedAt: '2026-10-18T12:00:00.000Z' }));
});
