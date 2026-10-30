import { mediaObjectReference } from '../../src/media/object-storage-contract.js';
import { LIVE_MEDIA_LIMITS, LIVE_MEDIA_TARGET, requireLiveMedia, liveMediaFail, sha256 } from './live-media-operator-config.mjs';

const DOCUMENT_LIMIT = 20_000;
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSETS = `SELECT tenant_id::text,id::text,room_id,'room' AS kind,content_type,byte_length,
  encode(content_sha256,'hex') AS digest,object_key,bytes IS NOT NULL AS has_bytes,
  CASE WHEN bytes IS NULL OR octet_length(bytes)<>byte_length OR byte_length>2097152 THEN false
    ELSE sha256(bytes)=content_sha256 END AS bytes_valid
  FROM public.tenant_room_media_assets
  UNION ALL SELECT tenant_id::text,id::text,NULL,'catalogue',content_type,byte_length,
  encode(content_sha256,'hex'),object_key,bytes IS NOT NULL,
  CASE WHEN bytes IS NULL OR octet_length(bytes)<>byte_length OR byte_length>2097152 THEN false
    ELSE sha256(bytes)=content_sha256 END
  FROM public.demo_catalogue_media_assets`;

function count(value, maximum = Number.MAX_SAFE_INTEGER) {
  const result = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  requireLiveMedia(Number.isSafeInteger(result) && result >= 0 && result <= maximum, 'LIVE_MEDIA_INVENTORY_INVALID');
  return result;
}

export async function assertOperatorIdentity(client, role) {
  const { rows } = await client.query(`SELECT current_database() AS database,current_user AS role,
    (SELECT max(version) FROM public.schema_migrations) AS schema_version,
    (SELECT max(version) FROM public.demo_schema_migrations) AS overlay_version,
    (SELECT count(*) FROM public.demo_database_sentinel WHERE singleton=true
      AND sentinel_key='conference-manager-shared-demo-v1' AND runtime_schema_version=1
      AND database_name=current_database() AND customer_role='cm_demo_customer'
      AND platform_role='cm_demo_platform' AND reset_role='cm_demo_reset') AS sentinel_count,
    has_table_privilege(current_user,'public.media_object_inventory','SELECT') AS inventory_select,
    has_table_privilege(current_user,'public.media_object_inventory','INSERT') AS inventory_insert,
    has_table_privilege(current_user,'public.media_object_inventory','UPDATE') AS inventory_update,
    has_table_privilege(current_user,'public.media_object_inventory','DELETE') AS inventory_delete,
    has_table_privilege(current_user,'public.tenant_room_media_assets','SELECT') AS room_select,
    has_table_privilege(current_user,'public.tenant_room_media_assets','UPDATE') AS room_update,
    has_table_privilege(current_user,'public.demo_catalogue_media_assets','SELECT') AS catalogue_select,
    has_table_privilege(current_user,'public.demo_catalogue_media_assets','UPDATE') AS catalogue_update,
    (SELECT NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
      FROM pg_catalog.pg_roles WHERE rolname=current_user) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE
        (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
          OR rolname IN ('postgres','neondb_owner','cm_demo_customer','cm_demo_platform','cm_demo_reset'))
        AND pg_has_role(current_user,oid,'MEMBER')) AS bounded_role`);
  const row = rows[0];
  requireLiveMedia(rows.length === 1 && row.database === LIVE_MEDIA_TARGET.databaseName && row.role === role
    && count(row.schema_version) === 75 && count(row.overlay_version) === 33 && count(row.sentinel_count) === 1
    && ['inventory_select', 'inventory_insert', 'inventory_update', 'inventory_delete',
      'room_select', 'room_update', 'catalogue_select', 'catalogue_update'].every((key) => row[key] === true)
    && row.bounded_role === true, 'LIVE_MEDIA_IDENTITY_INVALID');
}

export async function assertNoOtherDatabaseSessions(client, observe = () => {}) {
  await client.query('SELECT pg_stat_clear_snapshot()');
  const { rows } = await client.query(`SELECT
    (SELECT count(*) FROM pg_catalog.pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()) AS other_sessions,
    (SELECT count(*) FROM pg_catalog.pg_prepared_xacts WHERE database=current_database()) AS prepared_transactions,
    (SELECT count(*) FROM pg_catalog.pg_stat_activity
      WHERE pid=pg_backend_pid() AND datname=current_database()) AS own_session,
    (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() AND state='active') AS other_active,
    (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() AND state='idle') AS other_idle,
    (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() AND state IN ('idle in transaction','idle in transaction (aborted)')) AS other_in_transaction,
    (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() AND application_name='cm-live-media-operator') AS other_operator,
    (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() AND usename=current_user) AS other_same_role`);
  requireLiveMedia(rows.length === 1, 'LIVE_MEDIA_DATABASE_NOT_QUIESCENT');
  // Reconstruct fixed numeric fields only. Never forward database rows, session
  // identifiers, application names, query text, credentials or provider errors.
  const fields = ['other_sessions', 'prepared_transactions', 'own_session',
    'other_active', 'other_idle', 'other_in_transaction', 'other_operator', 'other_same_role'];
  const diagnostic = Object.fromEntries(fields.map((field) => [field, count(rows[0][field])]));
  requireLiveMedia(['other_active', 'other_idle', 'other_in_transaction', 'other_operator', 'other_same_role']
    .every((field) => diagnostic[field] <= diagnostic.other_sessions), 'LIVE_MEDIA_INVENTORY_INVALID');
  requireLiveMedia(diagnostic.other_active + diagnostic.other_idle + diagnostic.other_in_transaction
    <= diagnostic.other_sessions, 'LIVE_MEDIA_INVENTORY_INVALID');
  observe(Object.freeze(diagnostic));
  requireLiveMedia(diagnostic.other_sessions === 0 && diagnostic.prepared_transactions === 0
    && diagnostic.own_session === 1, 'LIVE_MEDIA_DATABASE_NOT_QUIESCENT');
}

async function validateRoomReferences(client) {
  const { rows: bounds } = await client.query(`WITH revisions AS MATERIALIZED (
    SELECT configuration FROM public.tenant_location_revisions LIMIT 20001) SELECT
    (SELECT count(*) FROM (SELECT 1 FROM public.rooms LIMIT 20001) r) AS current_rooms,
    (SELECT count(*) FROM revisions) AS revisions,
    (SELECT count(*) FROM revisions WHERE jsonb_typeof(configuration) IS DISTINCT FROM 'object'
      OR jsonb_typeof(configuration->'rooms') IS DISTINCT FROM 'array') AS invalid_roots`);
  requireLiveMedia(bounds.length === 1 && count(bounds[0].invalid_roots) === 0, 'LIVE_MEDIA_REFERENCES_INVALID');
  count(bounds[0].current_rooms, DOCUMENT_LIMIT);
  count(bounds[0].revisions, DOCUMENT_LIMIT);
  const { rows: sizes } = await client.query(`SELECT coalesce(sum(jsonb_array_length(configuration->'rooms')),0) AS rooms,
    coalesce(max(jsonb_array_length(configuration->'rooms')),0) AS per_revision FROM public.tenant_location_revisions`);
  requireLiveMedia(sizes.length === 1, 'LIVE_MEDIA_REFERENCES_INVALID');
  count(sizes[0].rooms, DOCUMENT_LIMIT);
  count(sizes[0].per_revision, 2000);
  const { rows } = await client.query(`WITH docs AS MATERIALIZED (
    SELECT tenant_id,id AS room_id,details AS doc,false AS historic FROM public.rooms
    UNION ALL SELECT r.tenant_id,j.doc->>'id',j.doc,true FROM public.tenant_location_revisions r
    CROSS JOIN LATERAL jsonb_array_elements(r.configuration->'rooms') AS j(doc)
  ), shaped AS MATERIALIZED (
    SELECT *,CASE WHEN jsonb_typeof(doc->'mediaAssetIds')='array' THEN jsonb_array_length(doc->'mediaAssetIds') ELSE 0 END AS media_count,
    CASE WHEN jsonb_typeof(doc->'mediaAssetIds')='array' THEN
      CASE WHEN jsonb_array_length(doc->'mediaAssetIds')<=20 THEN doc->'mediaAssetIds' ELSE '[]'::jsonb END
      ELSE '[]'::jsonb END AS media FROM docs
  ), refs AS MATERIALIZED (
    SELECT tenant_id,room_id,doc->'floorplanAssetId' AS value,true AS floorplan FROM shaped
    WHERE doc ? 'floorplanAssetId' AND doc->'floorplanAssetId' <> 'null'::jsonb
    UNION ALL SELECT tenant_id,room_id,m.value,false FROM shaped CROSS JOIN LATERAL jsonb_array_elements(media) AS m(value)
  ), checked AS (
    SELECT f.*,a.id AS matched,c.id AS catalogue_matched FROM refs f LEFT JOIN public.tenant_room_media_assets a
    ON a.tenant_id=f.tenant_id AND a.room_id=f.room_id AND a.id::text=lower(f.value #>> '{}')
    LEFT JOIN public.demo_catalogue_media_assets c ON f.floorplan AND c.tenant_id=f.tenant_id
      AND c.owner_kind='room_plan' AND c.owner_id=f.room_id AND c.id::text=lower(f.value #>> '{}')
  ) SELECT
    (SELECT count(*) FROM shaped WHERE jsonb_typeof(doc) IS DISTINCT FROM 'object'
      OR room_id IS NULL OR room_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      OR (historic AND (NOT(doc ? 'floorplanAssetId') OR NOT(doc ? 'mediaAssetIds')))
      OR (doc ? 'floorplanAssetId' AND jsonb_typeof(doc->'floorplanAssetId') NOT IN ('null','string'))
      OR (doc ? 'mediaAssetIds' AND jsonb_typeof(doc->'mediaAssetIds') IS DISTINCT FROM 'array')
      OR media_count>20) AS invalid_documents,
    (SELECT count(*) FROM shaped WHERE (SELECT count(*)<>count(DISTINCT value)
      FROM jsonb_array_elements(media) AS m(value))) AS duplicate_media_documents,
    (SELECT count(*) FROM checked WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
      OR (value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') AS invalid_references,
    (SELECT count(*) FROM checked WHERE matched IS NULL AND catalogue_matched IS NULL) AS dangling_or_misowned_references,
    (SELECT count(*) FROM checked WHERE matched IS NOT NULL AND catalogue_matched IS NOT NULL) AS ambiguous_references`);
  requireLiveMedia(rows.length === 1 && Object.values(rows[0]).every((value) => count(value) === 0),
    'LIVE_MEDIA_REFERENCES_INVALID');
}

export async function readLiveMediaInventory(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await validateRoomReferences(client);
    const { rows: sizes } = await client.query(`WITH assets AS MATERIALIZED (
      SELECT byte_length FROM public.tenant_room_media_assets
      UNION ALL SELECT byte_length FROM public.demo_catalogue_media_assets LIMIT 1001)
      SELECT count(*) AS assets,coalesce(sum(byte_length),0) AS bytes,
      count(*) FILTER (WHERE byte_length<1 OR byte_length>2097152) AS invalid FROM assets`);
    requireLiveMedia(sizes.length === 1 && count(sizes[0].invalid) === 0, 'LIVE_MEDIA_INVENTORY_INVALID');
    count(sizes[0].assets, LIVE_MEDIA_LIMITS.maxAssets);
    count(sizes[0].bytes, LIVE_MEDIA_LIMITS.maxBytes);
    const { rows } = await client.query(`SELECT * FROM (${ASSETS}) assets ORDER BY kind,tenant_id,id LIMIT 1001`);
    requireLiveMedia(rows.length <= LIVE_MEDIA_LIMITS.maxAssets, 'LIVE_MEDIA_INVENTORY_LIMIT');
    const { rows: custody } = await client.query(`SELECT object_key,tenant_id::text,asset_id::text,kind,content_type,
      byte_length,encode(content_sha256,'hex') AS digest FROM public.media_object_inventory ORDER BY object_key LIMIT 10001`);
    requireLiveMedia(custody.length <= 10_000, 'LIVE_MEDIA_INVENTORY_LIMIT');
    const inventory = new Map(custody.map((row) => [row.object_key, row]));
    requireLiveMedia(inventory.size === custody.length, 'LIVE_MEDIA_INVENTORY_INVALID');
    const seen = new Set();
    const result = { references: [], room: 0, catalogue: 0, bytes: 0, postgresOnly: 0,
      external: 0, postgresBytes: 0, invalidPostgresBytes: 0, otherCustody: custody.length };
    const manifest = [];
    for (const row of rows) {
      const reference = mediaObjectReference({ tenantId: row.tenant_id, assetId: row.id, kind: row.kind,
        contentType: row.content_type, byteLength: row.byte_length, sha256: row.digest });
      requireLiveMedia(!seen.has(reference.key) && (row.kind !== 'room' || ROOM_ID.test(row.room_id))
        && typeof row.has_bytes === 'boolean' && typeof row.bytes_valid === 'boolean'
        && (row.object_key === null || row.object_key === reference.key)
        && (row.has_bytes || row.object_key !== null), 'LIVE_MEDIA_INVENTORY_INVALID');
      seen.add(reference.key);
      const stored = inventory.get(reference.key);
      requireLiveMedia(row.object_key === null || stored, 'LIVE_MEDIA_CUSTODY_INVALID');
      if (stored) {
        requireLiveMedia(stored.tenant_id === reference.tenantId && stored.asset_id === reference.assetId
          && stored.kind === reference.kind && stored.content_type === reference.contentType
          && stored.byte_length === reference.byteLength && stored.digest === reference.sha256, 'LIVE_MEDIA_CUSTODY_INVALID');
        result.otherCustody -= 1;
      }
      result.references.push({ reference, objectKey: row.object_key, hasBytes: row.has_bytes, bytesValid: row.bytes_valid });
      manifest.push({ reference, roomId: row.room_id });
      result[row.kind] += 1;
      result.bytes += reference.byteLength;
      result[row.object_key === null ? 'postgresOnly' : 'external'] += 1;
      if (row.has_bytes) result.postgresBytes += 1;
      if (row.has_bytes && !row.bytes_valid) result.invalidPostgresBytes += 1;
    }
    requireLiveMedia(result.bytes <= LIVE_MEDIA_LIMITS.maxBytes, 'LIVE_MEDIA_INVENTORY_LIMIT');
    result.manifestSha256 = sha256(JSON.stringify(manifest));
    await client.query('COMMIT');
    return result;
  } catch {
    try { await client.query('ROLLBACK'); } catch { /* The caller closes this failed connection. */ }
    liveMediaFail('LIVE_MEDIA_INVENTORY_INVALID');
  }
}
