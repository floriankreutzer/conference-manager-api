import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isInternalUuid } from '../../src/domain/identifiers.js';
import { loadTargetOrigin, loadTargetScope } from './target-load-guard.mjs';

function valid(value) { if (!value) throw new Error('LOAD_TARGET_MANIFEST_FAILED'); }
function fields(value, keys) {
  valid(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
export function validateTargetLoadManifest(value, values, now = Date.now()) {
  try {
    const scope = loadTargetScope(values, now); valid(scope.surface === 'setup');
    fields(value, ['schemaVersion', 'runId', 'releaseSha', 'createdAt', 'expiresAt', 'origins', 'tenants',
      'managers', 'employees', 'expectedRooms', 'images', 'configurations', 'storageProbe']);
    valid(value.schemaVersion === 1 && value.runId === scope.runId && value.releaseSha === scope.releaseSha
      && value.createdAt === scope.createdAt && value.expiresAt === scope.expiresAt);
    fields(value.origins, ['customer', 'platform']);
    for (const surface of ['customer', 'platform']) loadTargetOrigin(value.origins[surface], scope.runId, surface);
    valid(Array.isArray(value.tenants) && value.tenants.length === 10 && value.tenants.every(isInternalUuid)
      && new Set(value.tenants.map(id => id.toLowerCase())).size === 10);
    const users = new Set(); const cookies = new Set();
    function actors(rows, role, size) {
      valid(Array.isArray(rows) && rows.length === size);
      rows.forEach((row, index) => {
        fields(row, ['tenantId', 'userId', 'roles', 'cookie']);
        valid(row.tenantId === value.tenants[index % 10] && isInternalUuid(row.userId)
          && !users.has(row.userId.toLowerCase()) && !cookies.has(row.cookie)
          && Array.isArray(row.roles) && row.roles.length === 1 && row.roles[0] === role
          && typeof row.cookie === 'string' && /^cm_session=[A-Za-z0-9_-]{43}$/.test(row.cookie));
        users.add(row.userId.toLowerCase()); cookies.add(row.cookie);
      });
    }
    actors(value.managers, 'conference_manager', 10);
    valid([100, 1000, 10_000].includes(value.employees?.length)); actors(value.employees, 'employee', value.employees.length);
    valid(Array.isArray(value.images) && value.images.length === 10);
    const assets = new Set();
    value.images.forEach(image => {
      fields(image, ['assetId', 'byteLength', 'sha256']);
      valid(isInternalUuid(image.assetId) && !assets.has(image.assetId.toLowerCase())
        && /^[a-f0-9]{64}$/.test(image.sha256) && Number.isSafeInteger(image.byteLength)
        && image.byteLength > 0 && image.byteLength <= 2 * 1024 * 1024); assets.add(image.assetId.toLowerCase());
    });
    fields(value.storageProbe, ['tenantId', 'assetId', 'byteLength', 'sha256']);
    valid(value.storageProbe.tenantId === value.tenants[0]
      && ['assetId', 'byteLength', 'sha256'].every(key => value.storageProbe[key] === value.images[0][key]));
    valid(Array.isArray(value.expectedRooms) && value.expectedRooms.length === 10);
    value.expectedRooms.forEach((rooms, tenant) => {
      valid(Array.isArray(rooms) && rooms.length === 10);
      rooms.forEach((room, index) => {
        fields(room, ['id', 'siteId', 'name', 'capacity', 'active', 'price', 'equipment', 'floorplanAssetId', 'mediaAssetIds']);
        fields(room.price, ['amountMinor', 'currency']);
        valid(room.id === (index === 0 ? 'room' : `room-0${index}`) && room.siteId === 'site'
          && room.name === `Synthetic ${tenant} room ${index}` && room.capacity === 20 && room.active === true
          && room.price.amountMinor === 1000 + tenant * 100 + index && room.price.currency === 'EUR'
          && Array.isArray(room.equipment) && room.equipment.length === 0 && room.floorplanAssetId === null
          && Array.isArray(room.mediaAssetIds) && room.mediaAssetIds.length === (index === 0 ? 1 : 0)
          && (index !== 0 || room.mediaAssetIds[0] === value.images[tenant].assetId));
      });
    });
    valid(Array.isArray(value.configurations) && value.configurations.length === 10);
    for (const configuration of value.configurations) {
      fields(configuration, ['revisions', 'context']);
      fields(configuration.revisions, ['organization', 'locations', 'catalogue', 'bookingPolicies', 'costAllocation']);
      valid(Object.values(configuration.revisions).every(revision => Number.isSafeInteger(revision) && revision >= 1)
        && typeof configuration.context === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(configuration.context));
    }
    valid(Buffer.byteLength(JSON.stringify(value)) <= 5_000_000);
    return structuredClone(value);
  } catch { throw new Error('LOAD_TARGET_MANIFEST_FAILED'); }
}

export async function readTargetLoadManifest(values, { clock = Date.now } = {}) {
  let file;
  try {
    const scope = loadTargetScope(values, clock()); valid(scope.surface === 'setup');
    file = await open(`/tmp/cm-saas38-load-${scope.runId}.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    valid(info.isFile() && info.nlink === 1 && info.uid === process.getuid() && (info.mode & 0o777) === 0o600
      && info.size > 0 && info.size <= 5_000_000);
    const bytes = Buffer.alloc(info.size + 1); let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      if (read.bytesRead === 0) break; count += read.bytesRead;
    }
    const after = await file.stat();
    valid(count === info.size && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs);
    return validateTargetLoadManifest(JSON.parse(bytes.subarray(0, count).toString('utf8')), values, clock());
  } catch { throw new Error('LOAD_TARGET_MANIFEST_FAILED'); }
  finally {
    try { await file?.close(); } catch { throw new Error('LOAD_TARGET_MANIFEST_FAILED'); }
  }
}
