import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mediaObjectReference, MediaObjectStorageError } from '../../src/media/object-storage-contract.js';
import { createPostgresMediaObjectRepository } from '../../src/persistence/postgres/media-object-repository.js';
import { readDemoSemanticState } from '../../src/persistence/postgres/demo-fixture-state.js';
import { DEMO_FIXTURE } from '../../src/demo/fixture.js';
import { RECOVERY_LOCATIONS_PATH, createRecoveryHttpClient, recoveryJson, assertRecoveryHttpError,
  assertRecoveryHttpMedia, assertRecoveryNotModified } from './neon-recovery-http.mjs';
import { createRecoveryFaultController, recoveryFaultReferences } from './neon-recovery-faults.mjs';
import { readRestoredMediaReferences, verifyRestoredProviderBytes, verifyRestoredSemanticState } from './neon-recovery-media.mjs';

const MAX_SNAPSHOT_ROWS = 10000;
const SNAPSHOT_TABLES = Object.freeze([
  ['tenant_room_media_assets', 'tenant_id, id', true],
  ['demo_catalogue_media_assets', 'tenant_id, id', true],
  ['media_object_inventory', 'object_key', false],
  ['rooms', 'tenant_id, id', false],
  ['sites', 'tenant_id, id', false],
  ['tenants', 'id', false],
  ['tenant_location_revisions', 'tenant_id, revision', false],
  ['catering_items', 'tenant_id, id', false],
  ['catering_packages', 'tenant_id, id', false],
  ['tenant_catalogue_revisions', 'tenant_id, revision', false],
]);

// Operator evidence only. Every column and every row of the affected authority and
// reference tables is bound; no raw private records or blob bytes enter the report.
// Session/telemetry/projection traffic is not part of this media rollback claim.
export async function readRecoveryAuthoritativeState(client, { assertActive = () => {} } = {}) {
  return readSnapshot(client, SNAPSHOT_TABLES, assertActive);
}

async function readSnapshot(client, tables, assertActive) {
  if (!client?.query || typeof assertActive !== 'function') throw new TypeError('NEON_RECOVERY_SNAPSHOT_INVALID');
  const hash = createHash('sha256');
  const rowCounts = {};
  try {
    assertActive();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    for (const [table, order, media] of tables) {
      assertActive();
      const record = media
        ? `(to_jsonb(entry) - 'bytes') || jsonb_build_object('bytes_sha256', encode(sha256(bytes), 'hex'),
          'bytes_length', octet_length(bytes), 'bytes_null', bytes IS NULL)`
        : 'to_jsonb(entry)';
      const result = await client.query({ name: `neon-recovery-snapshot-${table}`,
        text: `SELECT encode(sha256(convert_to((${record})::text, 'UTF8')), 'hex') AS digest
          FROM public.${table} AS entry ORDER BY ${order} LIMIT 10001` });
      if (result.rows.length > MAX_SNAPSHOT_ROWS
        || result.rows.some((row) => !/^[a-f0-9]{64}$/.test(row.digest || ''))) {
        throw new Error('NEON_RECOVERY_SNAPSHOT_INVALID');
      }
      rowCounts[table] = result.rows.length;
      hash.update(JSON.stringify([table, result.rows.map(({ digest }) => digest)]));
    }
    await client.query('COMMIT');
    return Object.freeze({ sha256: hash.digest('hex'), rowCounts: Object.freeze(rowCounts) });
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error('NEON_RECOVERY_SNAPSHOT_FAILED');
  }
}

export async function assertRecoveryFirstCandidate(client, input) {
  const reference = mediaObjectReference(input);
  const table = reference.kind === 'room' ? 'tenant_room_media_assets' : 'demo_catalogue_media_assets';
  const result = await client.query({ name: `neon-recovery-first-rollback-${reference.kind}`,
    text: `SELECT tenant_id, id, object_key, content_type, byte_length, encode(content_sha256, 'hex') AS sha256
      FROM public.${table} WHERE object_key IS NOT NULL ORDER BY tenant_id, id LIMIT 1` });
  const row = result.rows[0];
  if (row?.tenant_id !== reference.tenantId || row.id !== reference.assetId || row.object_key !== reference.key
    || row.content_type !== reference.contentType || row.byte_length !== reference.byteLength || row.sha256 !== reference.sha256) {
    throw new Error('NEON_RECOVERY_FIRST_CANDIDATE_INVALID');
  }
}

// A batch uses per-asset transactions. Deliberately choose its FIRST candidate and
// limit=1; failure of a later candidate would not undo earlier successful assets.
export async function verifyFailedRecoveryRollback({ client, repository, reference, expectedCode, assertActive }) {
  assertActive();
  await assertRecoveryFirstCandidate(client, reference);
  const before = await readRecoveryAuthoritativeState(client, { assertActive });
  let failure;
  try {
    assertActive();
    await repository.runBatch({ phase: 'rollback', kind: reference.kind, limit: 1 });
  } catch (error) { failure = error; }
  const after = await readRecoveryAuthoritativeState(client, { assertActive });
  if (!(failure instanceof MediaObjectStorageError) || failure.code !== expectedCode
    || before.sha256 !== after.sha256) throw new Error('NEON_RECOVERY_FAILED_ROLLBACK_INVALID');
  return Object.freeze({ kind: reference.kind, limit: 1, code: failure.code,
    before, after, authoritativeStateUnchanged: true });
}

export function recoveryMediaPath(reference, roomId) {
  if (reference.kind === 'catalogue') return `/api/v1/demo/media/${reference.assetId}`;
  if (typeof roomId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(roomId)) {
    throw new Error('NEON_RECOVERY_ROOM_INVALID');
  }
  return `/api/v1/tenant/rooms/${roomId}/media/${reference.assetId}`;
}

export async function verifyRecoveryMediaFaultHttp({ owner, foreign, anonymous, path, etag }) {
  const conditions = [null, etag, '*'];
  for (const condition of conditions) {
    assertRecoveryHttpError(await owner.request(path, { etag: condition }), 503, 'ROOM_MEDIA_UNAVAILABLE');
    assertRecoveryHttpError(await foreign.request(path, { etag: condition }), 404, 'NOT_FOUND');
    assertRecoveryHttpError(await anonymous.request(path, { etag: condition }), 401, 'UNAUTHENTICATED');
  }
  return Object.freeze({ normalGet: 503, matchingEtag: 503, wildcardEtag: 503,
    foreignTenant: 404, unauthenticated: 401, privateFailureResponseVerified: true });
}

export async function verifyRecoveryMediaReadable({ owner, path, reference, etag = null }) {
  const result = assertRecoveryHttpMedia(await owner.request(path), reference, etag);
  assertRecoveryNotModified(await owner.request(path, { etag: result.etag }), result.etag);
  return result;
}

// The normal Room GET only serves a currently attached asset. Historical custody
// is therefore proved by an authorized detach/history/read/rollback/reattach,
// not by inventing a history-media endpoint or bypassing attachment checks.
export async function verifyRecoveryRoomHistory({ client, owner, foreign, anonymous, reference, roomId, assertActive }) {
  assertActive();
  const path = recoveryMediaPath(reference, roomId);
  const original = await verifyRecoveryMediaReadable({ owner, path, reference });
  const before = await readSnapshot(client, SNAPSHOT_TABLES.slice(0, 3), assertActive);
  const current = recoveryJson(await owner.request(`${RECOVERY_LOCATIONS_PATH}?schemaVersion=3`)).locations;
  if (!Number.isSafeInteger(current?.revision) || current.revision < 1 || !Array.isArray(current.configuration?.rooms)) {
    throw new Error('NEON_RECOVERY_HISTORY_INVALID');
  }
  const configuration = structuredClone(current.configuration);
  const room = configuration.rooms.find(({ id }) => id === roomId);
  if (!Array.isArray(room?.mediaAssetIds) || room.mediaAssetIds.filter((id) => id === reference.assetId).length !== 1) {
    throw new Error('NEON_RECOVERY_HISTORY_INVALID');
  }
  room.mediaAssetIds = room.mediaAssetIds.filter((id) => id !== reference.assetId);
  const detached = recoveryJson(await owner.request(RECOVERY_LOCATIONS_PATH, { method: 'PUT',
    body: { schemaVersion: 3, expectedRevision: current.revision, configuration } })).locations;
  if (detached?.revision !== current.revision + 1) throw new Error('NEON_RECOVERY_HISTORY_INVALID');
  for (const etag of [null, original.etag, '*']) {
    assertRecoveryHttpError(await owner.request(path, { etag }), 404, 'NOT_FOUND');
  }
  const history = recoveryJson(await owner.request(`${RECOVERY_LOCATIONS_PATH}/history?limit=100`)).history;
  const saved = recoveryJson(await owner.request(
    `${RECOVERY_LOCATIONS_PATH}/history/${current.revision}?schemaVersion=3`,
  )).revision;
  if (!Array.isArray(history) || !history.some(({ revision }) => revision === current.revision)
    || saved?.revision !== current.revision
    || !isDeepStrictEqual(saved.configuration, current.configuration)) {
    throw new Error('NEON_RECOVERY_HISTORY_INVALID');
  }
  const detachedCustody = await readSnapshot(client, SNAPSHOT_TABLES.slice(0, 3), assertActive);
  if (detachedCustody.sha256 !== before.sha256) throw new Error('NEON_RECOVERY_HISTORY_CUSTODY_CHANGED');
  const restored = recoveryJson(await owner.request(`${RECOVERY_LOCATIONS_PATH}/rollback`, { method: 'POST',
    body: { schemaVersion: 3, expectedRevision: detached.revision, sourceRevision: current.revision } })).locations;
  if (restored?.revision !== detached.revision + 1
    || !isDeepStrictEqual(restored.configuration, current.configuration)) {
    throw new Error('NEON_RECOVERY_HISTORY_INVALID');
  }
  await verifyRecoveryMediaReadable({ owner, path, reference, etag: original.etag });
  assertRecoveryHttpError(await foreign.request(path, { etag: original.etag }), 404, 'NOT_FOUND');
  assertRecoveryHttpError(await anonymous.request(path, { etag: '*' }), 401, 'UNAUTHENTICATED');
  const after = await readSnapshot(client, SNAPSHOT_TABLES.slice(0, 3), assertActive);
  if (before.sha256 !== after.sha256) throw new Error('NEON_RECOVERY_HISTORY_CUSTODY_CHANGED');
  return Object.freeze({ kind: 'room', sourceRevision: current.revision, detachedRevision: detached.revision,
    restoredRevision: restored.revision, sha256: original.sha256, byteLength: original.byteLength,
    historicalConfigurationVerified: true, detachedReadDenied: true, authorizedReattachmentReadVerified: true,
    mediaCustodyUnchanged: true, custodySha256: before.sha256 });
}

export async function verifyRecoveryBaseline({ client, storage, assertActive = () => {} }) {
  try {
    assertActive();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const versions = await client.query(`SELECT (SELECT max(version) FROM public.schema_migrations) AS runtime,
      (SELECT max(version) FROM public.demo_schema_migrations) AS overlay`);
    if (versions.rows[0]?.runtime !== 44 || versions.rows[0]?.overlay !== 9) throw new Error('NEON_RECOVERY_SCHEMA_INVALID');
    const state = await readRestoredMediaReferences(client);
    assertActive();
    await verifyRestoredProviderBytes(storage, state.references);
    const mediaObjects = createPostgresMediaObjectRepository(client, { storage, includeDemoCatalogue: true });
    const semanticChecksum = verifyRestoredSemanticState(await readDemoSemanticState({ client, mediaObjects }));
    assertActive();
    await client.query('COMMIT');
    return Object.freeze({ ...state, semanticChecksum });
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error('NEON_RECOVERY_BASELINE_INVALID');
  }
}

export function recoveryHttpTenants(targets) {
  if (!Array.isArray(targets) || targets.length !== 2 || targets[0]?.kind !== 'room' || targets[1]?.kind !== 'catalogue'
    || targets.some((reference) => reference.tenantId !== targets[0].tenantId)) {
    throw new Error('NEON_RECOVERY_TENANT_FIXTURE_INVALID');
  }
  const owner = DEMO_FIXTURE.tenants.find(({ id, lifecycleStatus }) => id === targets[0].tenantId && lifecycleStatus === 'active');
  const foreign = DEMO_FIXTURE.tenants.filter(({ id, lifecycleStatus }) => id !== owner?.id && lifecycleStatus === 'ready');
  if (!owner || foreign.length !== 1) throw new Error('NEON_RECOVERY_TENANT_FIXTURE_INVALID');
  return Object.freeze({ ownerTenantId: owner.id, foreignTenantId: foreign[0].id });
}

export async function runRecoveryFaultScenarios({
  client, repository, storage, settings, references, expiresAt, assertAuthority, evidence,
}) {
  const tenants = recoveryHttpTenants(recoveryFaultReferences(references));
  const controller = await createRecoveryFaultController({ settings, references, storage, expiresAt, assertAuthority });
  const { assertActive } = controller;
  const owner = createRecoveryHttpClient({ assertActive });
  const foreign = createRecoveryHttpClient({ assertActive });
  const anonymous = createRecoveryHttpClient({ assertActive });
  try {
    const roomReference = controller.targets.find(({ kind }) => kind === 'room');
    await owner.establish(tenants.ownerTenantId);
    await foreign.establish(tenants.foreignTenantId);
    const room = await client.query({ name: 'neon-recovery-history-room',
      text: 'SELECT room_id FROM public.tenant_room_media_assets WHERE tenant_id = $1 AND id = $2',
      values: [roomReference.tenantId, roomReference.assetId] });
    const roomId = room.rows[0]?.room_id;
    for (const reference of controller.targets) {
      const path = recoveryMediaPath(reference, roomId);
      const original = await verifyRecoveryMediaReadable({ owner, path, reference });
      for (const fault of ['missing', 'corrupt']) {
        assertActive();
        await assertRecoveryFirstCandidate(client, reference);
        const entry = { kind: reference.kind, assetId: reference.assetId, fault, outcome: 'started' };
        evidence.cases.push(entry);
        const result = await controller.withFault(reference, fault, async (expectedCode) => {
          const httpEvidence = await verifyRecoveryMediaFaultHttp({ owner, foreign, anonymous, path, etag: original.etag });
          const rollback = await verifyFailedRecoveryRollback({ client, repository, reference, expectedCode, assertActive });
          return { http: httpEvidence, failedRollback: rollback };
        });
        Object.assign(entry, result, { outcome: 'provider_restored' });
        await verifyRecoveryMediaReadable({ owner, path, reference, etag: original.etag });
        Object.assign(entry, { outcome: 'passed', restoredApplicationReadVerified: true });
      }
    }
    evidence.history = await verifyRecoveryRoomHistory({ client, owner, foreign, anonymous,
      reference: roomReference, roomId, assertActive });
    const restored = await verifyRecoveryBaseline({ client, storage, assertActive });
    evidence.after = { manifestSha256: restored.digest, objects: restored.references.length,
      semanticChecksum: restored.semanticChecksum, retainedDatabaseBlobsVerified: true, providerBytesVerified: true };
    if (evidence.before.semanticChecksum !== restored.semanticChecksum) throw new Error('NEON_RECOVERY_BUSINESS_STATE_CHANGED');
  } finally {
    owner.close();
    foreign.close();
    anonymous.close();
    controller.close();
  }
}
