import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isInternalUuid } from '../../src/domain/identifiers.js';
import { normalizeRequestCompositionDraft } from '../../src/domain/request-composition.js';

const DIAGNOSTIC_CODES = new Set(['FINAL_ROOM_CALENDAR_WRITE_UNAVAILABLE', 'FINAL_ROOM_PROVIDER_UNAVAILABLE',
  'FINAL_ROOM_ENTITLEMENT_UNAVAILABLE', 'ROOM_AVAILABILITY_CONFLICT', 'VALIDATION_FAILED', 'FORBIDDEN',
  'RESOURCE_NOT_AVAILABLE', 'AUTHENTICATION_REQUIRED', 'CONFLICT', 'REQUEST_VERSION_CONFLICT',
  'REQUEST_STATE_CONFLICT', 'ENTITLEMENT_DENIED', 'AUDIT_INTEGRITY_FAILED']);

// One controlled sixteen-operation choreography. The injected transport owns fixed
// destination verification, bounded I/O/cancellation and byte/latency observation.
// This module supplies no network, provider, database or deployment authority.
export async function runBookingLoadJourney(options) {
  let operation = 'input'; let step = 'input'; let statusCode = 0; let publicCode = 'none';
  try {
    const { exchange, employee, manager, context, draft, images, expectedRooms, signal } = options;
    assert.equal(typeof exchange, 'function'); assert.ok(signal instanceof AbortSignal);
    assert.match(context, /^[A-Za-z0-9_-]{1,2048}$/);
    const actors = {};
    for (const [name, value] of Object.entries({ employee, manager })) {
      assert.ok(isInternalUuid(value?.tenantId) && isInternalUuid(value?.userId));
      assert.match(value.cookie, /^cm_session=[A-Za-z0-9_-]{43}$/);
      actors[name] = Object.freeze({ tenantId: value.tenantId, userId: value.userId, cookie: value.cookie });
    }
    assert.equal(actors.employee.tenantId, actors.manager.tenantId);
    assert.notEqual(actors.employee.userId, actors.manager.userId);
    const canonicalDraft = normalizeRequestCompositionDraft(draft, 3);
    assert.equal(canonicalDraft.roomId, 'room');
    assert.ok(Array.isArray(expectedRooms) && expectedRooms.length === 10);
    assert.ok(Buffer.byteLength(JSON.stringify(expectedRooms)) <= 8192);
    const catalog = structuredClone(expectedRooms);
    assert.equal(new Set(catalog.map(room => room.id)).size, 10);
    assert.ok(Array.isArray(images) && images.length === 3);
    const media = images.map(image => {
      assert.ok(isInternalUuid(image?.assetId)); assert.match(image.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(image.byteLength) && image.byteLength > 0 && image.byteLength <= 2097152);
      return Object.freeze({ assetId: image.assetId, sha256: image.sha256, byteLength: image.byteLength });
    });
    const observations = []; const csrf = {};
    async function perform(kind, actor, path, body, expectedVersion, binary = false) {
      operation = kind;
      step = kind === 'request_transition' ? body.transition : kind; statusCode = 0; publicCode = 'none';
      signal.throwIfAborted();
      const result = await exchange({ kind, actor, path, method: body === undefined ? 'GET' : 'POST',
        cookie: actors[actor].cookie, ...(body === undefined ? {} : { body, csrfToken: csrf[actor], expectedVersion }),
        binary, signal });
      signal.throwIfAborted();
      if (Number.isInteger(result.status) && result.status >= 100 && result.status <= 599) statusCode = result.status;
      if (DIAGNOSTIC_CODES.has(result.body?.error?.code)) publicCode = result.body.error.code;
      assert.equal(result.status, kind === 'request_create' ? 201 : 200);
      assert.ok(Number.isSafeInteger(result.payloadBytes) && result.payloadBytes >= 0
        && result.payloadBytes <= (binary ? 2097152 : 8192));
      assert.ok(Number.isSafeInteger(result.requestPayloadBytes) && result.requestPayloadBytes >= 0
        && result.requestPayloadBytes <= 8192);
      assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0 && result.latencyMs <= 60000);
      observations.push(Object.freeze({ kind, payloadBytes: result.payloadBytes,
        requestPayloadBytes: result.requestPayloadBytes, latencyMs: result.latencyMs }));
      return result.body;
    }
    for (const actor of ['employee', 'manager']) {
      const body = await perform('session_read', actor, '/api/v1/session');
      assert.equal(body.user.id, actors[actor].userId); assert.equal(body.tenant.id, actors[actor].tenantId);
      assert.deepEqual(body.roles, [actor === 'employee' ? 'employee' : 'conference_manager']);
      assert.match(body.csrfToken, /^[A-Za-z0-9_-]{43}$/); csrf[actor] = body.csrfToken;
    }
    const first = await perform('room_page_read', 'employee',
      `/api/v1/application/catalog?section=rooms&limit=5&context=${context}`);
    assert.equal(first.schemaVersion, 2); assert.equal(first.section, 'rooms'); assert.equal(first.context, context);
    assert.deepEqual(first.entries, catalog.slice(0, 5));
    assert.equal(first.entries.length, 5); assert.equal(first.page.complete, false);
    assert.match(first.page.nextCursor, /^[A-Za-z0-9_-]{1,2048}$/);
    const second = await perform('room_page_read', 'employee',
      `/api/v1/application/catalog?section=rooms&limit=5&cursor=${first.page.nextCursor}`);
    assert.equal(second.schemaVersion, 2); assert.equal(second.section, 'rooms'); assert.equal(second.context, context);
    assert.deepEqual(second.entries, catalog.slice(5));
    assert.equal(second.entries.length, 5); assert.equal(second.page.complete, true); assert.equal(second.page.nextCursor, null);
    const rooms = [...first.entries, ...second.entries];
    assert.equal(new Set(rooms.map(room => room.id)).size, 10);
    const room = rooms.find(value => value.id === canonicalDraft.roomId); assert.ok(room);
    for (const image of media) {
      assert.ok(room.mediaAssetIds.includes(image.assetId));
      const bytes = await perform('media_read', 'employee',
        `/api/v1/tenant/rooms/room/media/${image.assetId}`, undefined, undefined, true);
      assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.length, image.byteLength);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256);
    }
    const slot = { roomId: canonicalDraft.roomId, startsAt: canonicalDraft.startsAt, endsAt: canonicalDraft.endsAt };
    for (let index = 0; index < 2; index += 1) {
      const body = await perform('availability_lookup', 'employee', '/api/v1/application/room-availability', slot);
      assert.deepEqual(body.availability, { available: true, conflictCount: 0 });
    }
    const created = (await perform('request_create', 'employee', '/api/v1/application/requests',
      { schemaVersion: 3, request: canonicalDraft })).request;
    assert.ok(isInternalUuid(created.id)); assert.equal(created.status, 'Submitted'); assert.equal(created.version, 1);
    assert.equal(created.roomId, canonicalDraft.roomId);
    function verifyRequest(body, status, version) {
      const request = body.request;
      assert.equal(request.id, created.id); assert.equal(request.status, status); assert.equal(request.version, version);
      for (const field of ['roomId', 'details', 'pricing', 'allocations']) assert.deepEqual(request[field], created[field]);
      assert.equal('tenantId' in request, false); assert.equal('requesterUserId' in request, false);
    }
    verifyRequest({ request: created }, 'Submitted', 1);
    const path = `/api/v1/requests/${created.id}`;
    for (const actor of ['employee', 'manager']) verifyRequest(await perform('request_read', actor, path), 'Submitted', 1);
    verifyRequest(await perform('request_transition', 'manager', `${path}/transitions`, { transition: 'start_review' }, 1),
      'In Review', 2);
    verifyRequest(await perform('request_read', 'manager', path), 'In Review', 2);
    verifyRequest(await perform('request_transition', 'manager', `${path}/transitions`, { transition: 'confirm' }, 2),
      'Confirmed', 3);
    verifyRequest(await perform('request_read', 'employee', path), 'Confirmed', 3);
    assert.equal(observations.length, 16);
    return Object.freeze({ requestId: created.id, observations: Object.freeze(observations) });
  } catch {
    const error = new Error('LOAD_BOOKING_JOURNEY_FAILED');
    Object.assign(error, { operation, step, statusCode, publicCode }); throw error;
  }
}
