import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePrincipal } from '../../identity/principal.js';
import { normalizeSyntheticHandoffScope } from '../../domain/synthetic-handoff.js';
import { AuthorizationDeniedError } from '../../authorization/errors.js';
import { MediaObjectStorageError,mediaObjectReference,verifyMediaObjectBytes } from '../../media/object-storage-contract.js';
import { createPostgresProtectedCustomerAccessRepository } from './protected-customer-access-repository.js';
import { createPostgresSyntheticCustomerAccessRepository } from './synthetic-customer-access-repository.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from './transaction.js';

const ROOT='/api/v1/tenant/catalogue-media';
const OWNER_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function denied() { throw new AuthorizationDeniedError('AUTHORIZATION_DENIED'); }
function unavailable() { throw new MediaObjectStorageError(); }
function metadata(row) {
  if (!isInternalUuid(row.id) || !['room_plan','catering_package','catering_item'].includes(row.owner_kind)
    || typeof row.owner_id!=='string' || !OWNER_ID.test(row.owner_id)
    || !['image/png','image/webp'].includes(row.content_type)
    || typeof row.alt_text!=='string' || row.alt_text.length>160) unavailable();
  return Object.freeze({ id: row.id,ownerKind: row.owner_kind,ownerId: row.owner_id,
    contentType: row.content_type,altText: row.alt_text,url: `${ROOT}/${row.id}` });
}

// Only the protected Customer root constructs this reader. Each read owns the
// live deployment lease and requalifies current invited/delegated custody.
export function createPostgresProtectedCatalogueMediaRepository(pool,{ environment,securityEpoch,syntheticScope=null }={}) {
  if (typeof pool?.query!=='function' || typeof pool?.connect!=='function'
    || !['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_CATALOGUE_MEDIA_CONFIGURATION_INVALID');
  }
  const scope=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  if (syntheticScope!==null) {
    syntheticScope=normalizeSyntheticHandoffScope(syntheticScope);
    if (syntheticScope.environment!==environment || syntheticScope.securityEpoch!==scope.securityEpoch) {
      throw new TypeError('PROTECTED_CATALOGUE_MEDIA_CONFIGURATION_INVALID');
    }
  }
  const real=createPostgresProtectedCustomerAccessRepository(pool,scope);
  const synthetic=syntheticScope===null ? null : createPostgresSyntheticCustomerAccessRepository(pool,{ scope: syntheticScope });
  async function qualify(client,principal,tenantId) {
    const selected=await client.query({ name: 'protected-catalogue-media-current-tenant',text: `SELECT registry.mode
      FROM tenant_runtime_registry registry JOIN protected_runtime_deployments deployment
        ON deployment.environment=registry.environment AND deployment.security_epoch=$2
      JOIN tenants tenant ON tenant.id=registry.tenant_id
      WHERE registry.environment=$1 AND registry.tenant_id=$3 AND tenant.status IN ('onboarding','ready','active')`,
    values: [environment,scope.securityEpoch,tenantId] });
    const mode=selected.rows[0]?.mode,reader=mode==='real' ? real : mode==='synthetic' ? synthetic : null;
    if (!reader || (await reader.resolveCurrentAccess({ ...scope,principal }))?.runtime?.mode!==mode) denied();
    return mode;
  }
  async function read({ principal,tenantId,assetId=null,includeInactive=false },blob) {
    requireProtectedRuntimeSharedExecutionScope(pool,scope);
    try { principal=normalizePrincipal(principal); } catch { denied(); }
    if (principal.tenantId!==tenantId || !isInternalUuid(tenantId) || typeof includeInactive!=='boolean'
      || blob && !isInternalUuid(assetId)) denied();
    return withPostgresTransaction(pool,async client=>{
      const mode=await qualify(client,principal,tenantId);
      // REAL has no synthetic catalogue. Never read private synthetic storage as
      // a fallback for an unknown mode or failed current authority.
      if (mode==='real') return blob ? null : Object.freeze([]);
      const columns=blob ? 'asset.*' : 'asset.id,asset.owner_kind,asset.owner_id,asset.content_type,asset.alt_text';
      const result=await client.query({ name: blob ? 'protected-catalogue-media-bytes' : 'protected-catalogue-media-list',
        text: `SELECT ${columns} FROM synthetic_catalogue_media_assets asset
        WHERE asset.tenant_id=$1 AND ($2::uuid IS NULL OR asset.id=$2) AND (
          (asset.owner_kind='room_plan' AND EXISTS(SELECT 1 FROM rooms room
            JOIN sites site ON site.tenant_id=room.tenant_id AND site.id=room.site_id
            WHERE room.tenant_id=asset.tenant_id AND room.id=asset.owner_id
              AND room.details->>'floorplanAssetId'=asset.id::text AND ($3 OR (room.active AND site.active))))
          OR (asset.owner_kind='catering_package' AND EXISTS(SELECT 1 FROM catering_packages package
            WHERE package.tenant_id=asset.tenant_id AND package.id=asset.owner_id AND ($3 OR package.active)))
          OR (asset.owner_kind='catering_item' AND EXISTS(SELECT 1 FROM catering_items item
            WHERE item.tenant_id=asset.tenant_id AND item.id=asset.owner_id AND ($3 OR item.active))))
        ORDER BY asset.id LIMIT 41`,values: [tenantId,assetId,includeInactive] });
      if (result.rows.length>40 || blob && result.rows.length>1) unavailable();
      let value;
      if (!blob) value=Object.freeze(result.rows.map(metadata));
      else if (!result.rows.length) value=null;
      else {
        const row=result.rows[0],entry=metadata(row);
        if (row.object_key!==null || !Buffer.isBuffer(row.bytes) || !Buffer.isBuffer(row.content_sha256)
          || row.content_sha256.length!==32 || !Number.isSafeInteger(row.byte_length)
          || row.byte_length<32 || row.byte_length>2097152) unavailable();
        const reference=mediaObjectReference({ tenantId,assetId: entry.id,kind: 'catalogue',
          contentType: entry.contentType,byteLength: row.byte_length,sha256: row.content_sha256.toString('hex') });
        value=Object.freeze({ ...entry,bytes: Buffer.from(verifyMediaObjectBytes(row.bytes,reference)) });
      }
      if (await qualify(client,principal,tenantId)!==mode) denied();
      return value;
    },{ readOnly: true });
  }
  return Object.freeze({ list: input=>read(input,false),find: input=>read(input,true) });
}
