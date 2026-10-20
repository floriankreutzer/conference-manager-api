import { readFile } from 'node:fs/promises';
import { createApplicationCatalogContext } from '../../src/application/catalog-page.js';
import { isInternalUuid } from '../../src/domain/identifiers.js';
import { measureSessionReads } from '../session-load-evidence.mjs';

function valid(value) { if (!value) throw new Error('LOAD_MEDIA_FIXTURES_FAILED'); }
async function boundedJson(response) {
  let length = 0; const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length; valid(length <= 8192); chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Bootstrap through the actual owned loopback HTTP server and Manager/CSRF upload
// path. The caller cannot select an outbound URL or attach a foreign object key.
export async function prepareBookingLoadMedia({ runtime, config, persistence, tenants, managers, expectedRooms,
  assertActive = () => {} } = {}) {
  try {
    const address = runtime.server.address();
    valid(address && address.address === '127.0.0.1' && Number.isInteger(address.port) && address.port > 0
      && config.publicOrigin === `http://127.0.0.1:${address.port}` && typeof assertActive === 'function'
      && Array.isArray(tenants) && tenants.length === 10 && new Set(tenants).size === 10
      && Array.isArray(managers) && managers.length === 10 && Array.isArray(expectedRooms) && expectedRooms.length === 10);
    valid(managers.every((manager, index) => manager.tenantId === tenants[index] && isInternalUuid(manager.userId)
      && /^cm_session=[A-Za-z0-9_-]{43}$/.test(manager.cookie)));
    const managerTokens = []; assertActive();
    await measureSessionReads({ origin: config.publicOrigin, cookies: managers.map(manager => manager.cookie), verify(body, index) {
      valid(body.user.id === managers[index].userId && body.tenant.id === tenants[index]);
      valid(typeof body.csrfToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.csrfToken));
      managerTokens[index] = body.csrfToken;
    } });
    assertActive(); const images = [];
    for (let index = 0; index < tenants.length; index += 1) {
      assertActive();
      const encoded = await readFile(new URL(
        `../../src/synthetic/media/northwind-room-0${index % 3 + 1}.webp.b64`, import.meta.url,
      ), 'utf8');
      const bytes = Buffer.from(encoded, 'base64'); valid(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024); assertActive();
      const response = await fetch(`${config.publicOrigin}/api/v1/tenant/rooms/room/media`, {
        method: 'POST', headers: { Cookie: managers[index].cookie, Origin: config.publicOrigin,
          'X-CSRF-Token': managerTokens[index], 'Content-Type': 'image/webp' }, body: bytes,
        redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      valid(response.status === 201); const uploaded = await boundedJson(response); assertActive();
      valid(isInternalUuid(uploaded.assetId)); const assetId = uploaded.assetId;
      await persistence.pool.query(`UPDATE public.rooms SET details=jsonb_build_object('mediaAssetIds',jsonb_build_array($2::text))
        WHERE tenant_id=$1 AND id='room'`, [tenants[index], assetId]);
      assertActive();
      const stored = await persistence.pool.query(`SELECT byte_length,encode(content_sha256,'hex') AS sha256
        FROM public.tenant_room_media_assets WHERE tenant_id=$1 AND id=$2 AND room_id='room'
          AND bytes IS NULL AND object_key IS NOT NULL`, [tenants[index], assetId]);
      assertActive(); valid(stored.rowCount === 1);
      const image = stored.rows[0]; valid(Number.isInteger(image.byte_length) && image.byte_length > 0
        && image.byte_length <= 2 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(image.sha256));
      expectedRooms[index][0].mediaAssetIds = [assetId];
      images[index] = { assetId, byteLength: image.byte_length, sha256: image.sha256 };
    }
    const configurations = [];
    for (const tenantId of tenants) {
      assertActive();
      const page = await persistence.applicationRepository.loadCatalogPage({ tenantId, section: 'sites', limit: 1 });
      assertActive(); valid(page.status === 'ready');
      configurations.push({ revisions: page.configurationRevisions, context: createApplicationCatalogContext({
        revisions: page.configurationRevisions, policyVersionId: page.bookingPolicy.policyVersionId }) });
    }
    return { images, managerTokens, configurations };
  } catch { throw new Error('LOAD_MEDIA_FIXTURES_FAILED'); }
}
