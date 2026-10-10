import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sendPrivateMediaResponse } from '../src/http/private-media-response.js';
import { verifyRecoveryRoomHistory, readRecoveryAuthoritativeState } from '../scripts/support/neon-recovery-scenarios.mjs';
import { recoveryFaultReferences } from '../scripts/support/neon-recovery-faults.mjs';
import { recoveryReferences, recoveryBytes } from './support/neon-recovery-fixture.js';

const reference = recoveryFaultReferences(recoveryReferences)[0];
const roomId = 'northwind-berlin-room-1';
const locations = '/api/v1/tenant/settings/locations';
const mediaPath = `/api/v1/tenant/rooms/${roomId}/media/${reference.assetId}`;

function json(value, status = 200) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    bytes: Buffer.from(JSON.stringify(value)) };
}

function denied(status, code) { return json({ error: { code, requestId: 'bounded-request-id' } }, status); }

function snapshotClient() {
  const statements = [];
  return { statements, async query(statement) {
    const text = typeof statement === 'string' ? statement : statement.text;
    statements.push(text);
    const table = text.match(/FROM public\.([a-z_]+) AS entry/);
    return { rows: table ? [{ digest: createHash('sha256').update(table[1]).digest('hex') }] : [] };
  } };
}

function historyFixture({ damageHistory = false } = {}) {
  const original = { sites: [{ id: 'northwind-berlin', name: 'Berlin', active: true, timeZone: 'Europe/Berlin' }],
    rooms: [{ id: roomId, siteId: 'northwind-berlin', name: 'Room', capacity: 10, active: true,
      mediaAssetIds: [reference.assetId], floorplanAssetId: '52000000-0000-4000-8000-000000000001' }] };
  const state = { revision: 7, configuration: structuredClone(original), history: new Map() };
  const calls = [];
  const owner = { async request(path, options = {}) {
    calls.push({ path, ...options });
    if (path === `${locations}?schemaVersion=3`) return json({ locations: {
      revision: state.revision, configuration: state.configuration,
    } });
    if (path === locations && options.method === 'PUT') {
      assert.equal(options.body.schemaVersion, 3);
      assert.equal(options.body.expectedRevision, state.revision);
      const expected = structuredClone(original);
      expected.rooms[0].mediaAssetIds = [];
      assert.deepEqual(options.body.configuration, expected);
      state.history.set(state.revision, structuredClone(state.configuration));
      state.revision += 1;
      state.configuration = structuredClone(options.body.configuration);
      return json({ locations: { revision: state.revision, configuration: state.configuration } });
    }
    if (path === `${locations}/history?limit=100`) return json({ history: [{ revision: 7 }] });
    if (path === `${locations}/history/7?schemaVersion=3`) {
      const saved = structuredClone(state.history.get(7));
      if (damageHistory) saved.rooms[0].mediaAssetIds = [];
      return json({ revision: { revision: 7, configuration: saved } });
    }
    if (path === `${locations}/rollback`) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.body, { schemaVersion: 3, expectedRevision: 8, sourceRevision: 7 });
      state.configuration = structuredClone(state.history.get(7));
      state.revision += 1;
      return json({ locations: { revision: state.revision, configuration: state.configuration } });
    }
    assert.equal(path, mediaPath);
    if (!state.configuration.rooms[0].mediaAssetIds.includes(reference.assetId)) return denied(404, 'NOT_FOUND');
    const headers = {};
    let bytes = Buffer.alloc(0);
    const response = { statusCode: 0, setHeader(name, value) { headers[name.toLowerCase()] = String(value); },
      end(value) { if (value !== undefined) bytes = Buffer.from(value); } };
    sendPrivateMediaResponse({ request: { headers: options.etag ? { 'if-none-match': options.etag } : {} }, response,
      tenantId: reference.tenantId, assetId: reference.assetId, contentType: reference.contentType, bytes: recoveryBytes(reference) });
    return { status: response.statusCode, headers, bytes };
  } };
  return { original, state, calls, owner, foreign: { async request() { return denied(404, 'NOT_FOUND'); } },
    anonymous: { async request() { return denied(401, 'UNAUTHENTICATED'); } } };
}

test('historical Room proof denies detached conditional reads and reattaches through the existing HTTP rollback', async () => {
  const fixture = historyFixture();
  const client = snapshotClient();
  const evidence = await verifyRecoveryRoomHistory({ ...fixture, client, reference, roomId, assertActive() {} });
  assert.equal(evidence.sourceRevision, 7);
  assert.equal(evidence.detachedRevision, 8);
  assert.equal(evidence.restoredRevision, 9);
  assert.equal(evidence.authorizedReattachmentReadVerified, true);
  assert.equal(evidence.mediaCustodyUnchanged, true);
  assert.equal(evidence.sha256, reference.sha256);
  assert.deepEqual(fixture.state.configuration, fixture.original);
  assert.deepEqual(fixture.state.history.get(7), fixture.original);
  assert.deepEqual(fixture.calls.filter(({ method }) => method).map(({ method }) => method), ['PUT', 'POST']);
  const detachAt = fixture.calls.findIndex(({ method }) => method === 'PUT');
  assert.deepEqual(fixture.calls.slice(detachAt + 1, detachAt + 4).map(({ etag }) => etag === null ? null : etag === '*' ? '*' : 'etag'),
    [null, 'etag', '*']);
  assert.equal(client.statements.some((statement) => /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(statement)), false);
});

test('missing historical attachment evidence stops acceptance without inventing a new authority or media endpoint', async () => {
  const fixture = historyFixture({ damageHistory: true });
  await assert.rejects(verifyRecoveryRoomHistory({ ...fixture, client: snapshotClient(), reference, roomId, assertActive() {} }),
    /NEON_RECOVERY_HISTORY_INVALID/);
  assert.equal(fixture.calls.some(({ path }) => path === `${locations}/rollback`), false);
  assert.equal(fixture.calls.some(({ path }) => /history.*media/.test(path)), false);
});

test('snapshot failures roll back and redact database diagnostics', async () => {
  const statements = [];
  const client = { async query(statement) {
    const text = typeof statement === 'string' ? statement : statement.text;
    statements.push(text);
    if (text.includes('FROM public.')) throw new Error('private database connection credential diagnostic');
    return { rows: [] };
  } };
  await assert.rejects(readRecoveryAuthoritativeState(client), { message: 'NEON_RECOVERY_SNAPSHOT_FAILED' });
  assert.equal(statements[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(statements.at(-1), 'ROLLBACK');
});
