import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runBookingLoadJourney } from '../scripts/support/booking-load-journey.mjs';
import { requestLoadDraft } from './support/request-load-draft.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const bytes = Buffer.from('controlled image');
const image = { assetId, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const token = 'a'.repeat(43);
const expectedRooms = Array.from({ length: 10 }, (_, index) => ({
  id: index === 0 ? 'room' : `room-${Math.floor(index / 5) + 1}-${index % 5}`, mediaAssetIds: [assetId],
}));
const options = { employee: { tenantId, userId: '44444444-4444-4444-8444-444444444444', cookie: `cm_session=${token}` },
  manager: { tenantId, userId: '55555555-5555-4555-8555-555555555555', cookie: `cm_session=${'b'.repeat(43)}` },
  context: 'context', draft: requestLoadDraft(), images: [image, image, image], expectedRooms };

function model({ failAt, abort, corruptAt } = {}) {
  const calls = []; let status = 'Submitted'; let version = 1; let pages = 0;
  const record = () => ({ id: requestId, status, version, roomId: 'room', details: { title: 'Controlled' },
    pricing: { totalMinor: 1000 }, allocations: [] });
  return { calls, async exchange(input) {
    calls.push(input);
    if (calls.length === failAt) throw new Error('private-cookie-or-provider-details');
    let body;
    if (input.kind === 'session_read') body = { user: { id: options[input.actor].userId }, tenant: { id: tenantId },
      roles: [input.actor === 'employee' ? 'employee' : 'conference_manager'], csrfToken: token };
    else if (input.kind === 'room_page_read') {
      pages += 1;
      body = { schemaVersion: 2, section: 'rooms', context: 'context',
        entries: structuredClone(expectedRooms.slice((pages - 1) * 5, pages * 5)),
        page: { complete: pages === 2, nextCursor: pages === 1 ? 'cursor' : null } };
    } else if (input.kind === 'media_read') body = bytes;
    else if (input.kind === 'availability_lookup') body = { availability: { available: true, conflictCount: 0 } };
    else {
      if (input.kind === 'request_transition') {
        assert.equal(input.actor, 'manager'); assert.equal(input.expectedVersion, version);
        status = input.body.transition === 'start_review' ? 'In Review' : 'Confirmed'; version += 1;
      }
      body = { request: record() };
    }
    if (input.method === 'POST') assert.equal(input.csrfToken, token);
    const result = { status: input.kind === 'request_create' ? 201 : 200, body,
      payloadBytes: Buffer.isBuffer(body) ? body.length : Buffer.byteLength(JSON.stringify(body)),
      requestPayloadBytes: input.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(input.body)), latencyMs: 1 };
    if (calls.length === corruptAt) result.status = 503;
    if (calls.length === 1) abort?.abort();
    return result;
  } };
}

test('booking choreography executes exactly the approved mix and preserves actor/version authority', async () => {
  const transport = model();
  const result = await runBookingLoadJourney({ ...options, exchange: transport.exchange, signal: new AbortController().signal });
  assert.equal(result.requestId, requestId);
  assert.deepEqual(result.observations.reduce((counts, row) => ({ ...counts, [row.kind]: (counts[row.kind] ?? 0) + 1 }), {}),
    { session_read: 2, room_page_read: 2, media_read: 3, availability_lookup: 2,
      request_create: 1, request_read: 4, request_transition: 2 });
  assert.equal(transport.calls.filter(x => x.method === 'POST').length, 5);
  assert.equal(transport.calls[3].path, '/api/v1/application/catalog?section=rooms&limit=5&cursor=cursor');
  assert.ok(Object.isFrozen(result.observations));
});

test('every dependency or response failure stops without retry, further writes or private error details', async () => {
  for (let step = 1; step <= 16; step += 1) {
    for (const fault of ['failAt', 'corruptAt']) {
      const transport = model({ [fault]: step });
      await assert.rejects(runBookingLoadJourney({ ...options, exchange: transport.exchange,
        signal: new AbortController().signal }), error => {
        assert.equal(error.message, 'LOAD_BOOKING_JOURNEY_FAILED'); assert.equal(error.cause, undefined); return true;
      });
      assert.equal(transport.calls.length, step);
    }
  }
});

test('invalid fixture scope fails before transport and cancellation after I/O cannot advance the journey', async () => {
  for (const patch of [{ context: '../escape' }, { images: [] }, { images: [{ ...image, byteLength: 2097153 }, image, image] },
    { manager: { ...options.manager, tenantId: requestId } }, { employee: { ...options.employee, cookie: 'bad' } }]) {
    const transport = model();
    await assert.rejects(runBookingLoadJourney({ ...options, ...patch, exchange: transport.exchange,
      signal: new AbortController().signal }), /LOAD_BOOKING_JOURNEY_FAILED/);
    assert.equal(transport.calls.length, 0);
  }
  const controller = new AbortController(); const transport = model({ abort: controller });
  await assert.rejects(runBookingLoadJourney({ ...options, exchange: transport.exchange, signal: controller.signal }),
    /LOAD_BOOKING_JOURNEY_FAILED/);
  assert.equal(transport.calls.length, 1);
});
