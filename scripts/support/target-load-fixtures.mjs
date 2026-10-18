import { randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../src/domain/identifiers.js';
import { seedLoadSessions } from './target-load-sessions.mjs';

// Caller must establish installer/disposable-loopback authority before invoking
// this fixed synthetic seed. No migrations, provider allocation or HTTP bypass.
async function seedBookingLoadFixturesInternal(pool, tenants, {
  population = 1000, publicOrigin = 'http://127.0.0.1:3000', sessionTtlSeconds,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || !Array.isArray(tenants) || tenants.length !== 10
    || tenants.some(id => !isInternalUuid(id)) || new Set(tenants.map(id => id.toLowerCase())).size !== 10
    || ![100, 1000, 10_000].includes(population)) throw new Error('LOAD_BOOKING_FIXTURES_INVALID');
  await pool.query(`INSERT INTO tenants(id,display_name,status)
    SELECT id,'Synthetic journey fixture','active' FROM unnest($1::uuid[]) AS id`, [tenants]);
  await pool.query(`INSERT INTO sites(tenant_id,id,name,time_zone)
    SELECT id,'site','Synthetic site','Europe/Berlin' FROM unnest($1::uuid[]) AS id`, [tenants]);
  const expectedRooms = tenants.map((tenantId, tenantIndex) => Array.from({ length: 10 }, (_, roomIndex) => ({
    id: roomIndex === 0 ? 'room' : `room-0${roomIndex}`, siteId: 'site', name: `Synthetic ${tenantIndex} room ${roomIndex}`,
    capacity: 20, active: true, price: { amountMinor: 1000 + tenantIndex * 100 + roomIndex, currency: 'EUR' },
    equipment: [], floorplanAssetId: null, mediaAssetIds: [],
  })));
  const rows = JSON.stringify(tenants.flatMap((tenantId, index) => expectedRooms[index].map(room => ({ tenantId, ...room }))));
  await pool.query(`INSERT INTO rooms(tenant_id,id,site_id,name,capacity)
    SELECT "tenantId",id,'site',name,capacity FROM jsonb_to_recordset($1::jsonb)
    AS fixture("tenantId" uuid,id text,name text,capacity integer)`, [rows]);
  await pool.query(`INSERT INTO tenant_room_prices(tenant_id,room_id,price_minor,currency,created_at,updated_at)
    SELECT "tenantId",id,(price->>'amountMinor')::bigint,'EUR',transaction_timestamp(),transaction_timestamp()
    FROM jsonb_to_recordset($1::jsonb) AS fixture("tenantId" uuid,id text,price jsonb)`, [rows]);
  const bindings = new Map();
  for (let index = 0; index < tenants.length; index += 1) {
    const tenantId = tenants[index]; const integration = randomUUID(); const reference = randomUUID();
    const address = `room${index}@synthetic.invalid`; bindings.set(reference, { address });
    await pool.query(`INSERT INTO tenant_entitlements(tenant_id,capability_id,enabled)
      SELECT $1,id,true FROM unnest($2::text[]) id`,
    [tenantId, ['microsoft.directory', 'microsoft.calendar', 'microsoft.calendar.write']]);
    await pool.query(`INSERT INTO tenant_identity_bindings
      (id,tenant_id,provider,provider_tenant_reference,status,created_at,updated_at)
      VALUES($1,$2,'microsoft_entra',$3,'active',transaction_timestamp(),transaction_timestamp())`,
    [randomUUID(), tenantId, reference]);
    await pool.query(`INSERT INTO integrations
      (tenant_id,id,provider,provider_reference,status,connection_version,last_verified_at,
       places_permission_status,calendars_permission_status,created_at,updated_at)
      VALUES($1,$2,'microsoft365',$3,'connected',1,transaction_timestamp(),'granted','granted',
      transaction_timestamp(),transaction_timestamp())`, [tenantId, integration, reference]);
    await pool.query(`INSERT INTO microsoft365_room_mappings
      (tenant_id,room_id,integration_id,external_room_id,resource_address,provider_display_name,provider_capacity,
       last_seen_at,created_at,updated_at) VALUES($1,'room',$2,$3,$4,'Synthetic room',20,
       transaction_timestamp(),transaction_timestamp(),transaction_timestamp())`, [tenantId, integration, randomUUID(), address]);
  }
  const managers = []; const employees = [];
  await seedLoadSessions(pool, tenants, managers, 10, { roles: ['conference_manager'], publicOrigin, sessionTtlSeconds });
  await seedLoadSessions(pool, tenants, employees, population, { roles: ['employee'], publicOrigin, sessionTtlSeconds });
  return { expectedRooms, bindings, managers, employees };
}

export async function seedBookingLoadFixtures(...args) {
  try { return await seedBookingLoadFixturesInternal(...args); }
  catch { throw new Error('LOAD_BOOKING_FIXTURES_FAILED'); }
}
