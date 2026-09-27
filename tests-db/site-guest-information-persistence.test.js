import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantLocationRepository } from '../src/persistence/postgres/tenant-location-repository.js';
import { createPostgresRequestRepository } from '../src/persistence/postgres/request-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT_A = '37111111-1111-4111-8111-111111111111';
const TENANT_B = '37222222-2222-4222-8222-222222222222';
const USER = '37333333-3333-4333-8333-333333333333';
const guest = Object.freeze({ address: null, publicTransport: null, arrival: 'Northwind visitor reception',
  parking: null, reception: null, building: null, visitorNotes: null, accessibility: null,
  wifiPolicy: 'not_available', wifiNetworkName: null, contact: null, routeUrl: null });
const publicGuest = Object.freeze({ ...guest, arrival: null });

test('Guest Information persists atomically with Locations and survives legacy writes and rollbacks', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database });
  t.after(() => pool.end());
  await migrateUp(pool);
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Guest test','active')", [tenantId]);
    await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Guest administrator')", [tenantId, USER]);
    await pool.query(`INSERT INTO sites(tenant_id,id,name,active,time_zone,details)
      VALUES($1,'same-site','Campus',true,'Europe/Berlin','{"address":null}'::jsonb)`, [tenantId]);
    await pool.query(`INSERT INTO rooms(tenant_id,id,site_id,name,capacity,active,details)
      VALUES($1,'same-room','same-site','Meeting room',12,true,'{}'::jsonb)`, [tenantId]);
  }
  let failAudit = false;
  const auditRepository = { async appendWithClient() {
    if (failAudit) throw new Error('AUDIT_TEST_FAILURE');
    return { id: 'committed-test-audit' };
  } };
  const repository = createPostgresTenantLocationRepository(pool, { auditRepository });
  const update = async (configuration, revision, schemaVersion = 2) => repository.update({
    tenantId: TENANT_A, expectedRevision: revision, nextRevision: revision + 1,
    configuration, schemaVersion, changedAt: new Date(), actorUserId: USER,
    auditEvent: {}, assertAuthorizedTransition: () => true,
  });
  const rollback = async (revision, sourceRevision, schemaVersion) => repository.rollback({
    tenantId: TENANT_A, expectedRevision: revision, nextRevision: revision + 1, sourceRevision,
    schemaVersion, changedAt: new Date(), actorUserId: USER,
    auditEvent: {}, assertAuthorizedTransition: () => true,
  });
  const initial = await repository.current(TENANT_A, { schemaVersion: 2 });
  assert.equal(initial.configuration.sites[0].guestInformation, null);
  for (const disclosure of [
    'Door code 1234', 'Wi-Fi code 1234', 'WLAN code 1234', 'Guest WiFi code alpha',
    'Doo\u0433 code 1234', 'Door c\u0585de 1234',
    'D-o-o-\u0433 code 1234', 'D.o.o.\u0433 c\u0585de 1234',
    'Doorcode1234', 'Doorcode2', 'Doorcode\u0662', 'Door code1234',
    'PasswortSommer2026', 'WiFipasswordSommer2026',
    'P\u0251ssword: Sommer2026', '\u1d18\u026a\u0274 1234', 'passwordsecret', 'doorcodeblue',
    'Doo \u0433 code 1234', '\u0440\u0430\u0455\u0455\u051d\u043e\u0433\u0501',
    'PASSWORDSecret', '1Password: Secret',
    'Door@code 1234', 'API@key abc123',
    'Door@c0de 1234', 'Door$c0de 1234', 'API@k3y abc123', 'API$k3y abc123',
    'GuestPassword1234', 'MainDoorcode1234', 'OfficeDoor code 1234', 'SecretPIN1234',
    '\u13e2\u13aa\u13da\u13da\u13b3\u13be\u13a1\u13a0 Sommer2026',
    '\u13e2\u13c6\u13c1 1234', '\u13e2.\u13c6.\u13c1 1234',
    'API key abc123', 'Voucher: ABCD-1234', 'Pass\u051dord Sommer2026',
    'Passcode 1234', 'Wi-Fi passcode 1234', 'Auth token abc', 'One-time code 1234',
    'WiFi secret abc', 'Access key abc',
  ]) {
    const disclosed = { ...initial.configuration,
      sites: initial.configuration.sites.map((site) => ({
        ...site,
        guestInformation: { ...guest, arrival: disclosure },
      })) };
    await assert.rejects(update(disclosed, 1), /TENANT_SITE_GUEST_INFORMATION_INVALID/);
  }
  for (const [field, disclosure, code] of [
    ['floor', 'Door code 1234', 'TENANT_ROOM_FLOOR_INVALID'],
    ['floor', 'Doo\u0433 code 1234', 'TENANT_ROOM_FLOOR_INVALID'],
    ['accessibility', ['Door c\u0585de 1234'], 'TENANT_ROOM_ACCESSIBILITY_INVALID'],
    ['floor', 'D-o-o-\u0433 code 1234', 'TENANT_ROOM_FLOOR_INVALID'],
    ['accessibility', ['D.o.o.\u0433 c\u0585de 1234'], 'TENANT_ROOM_ACCESSIBILITY_INVALID'],
    ['floor', 'Doorcode1234', 'TENANT_ROOM_FLOOR_INVALID'],
    ['accessibility', ['PasswortSommer2026'], 'TENANT_ROOM_ACCESSIBILITY_INVALID'],
    ['floor', 'GuestPassword1234', 'TENANT_ROOM_FLOOR_INVALID'],
    ['accessibility', ['MainDoorcode1234'], 'TENANT_ROOM_ACCESSIBILITY_INVALID'],
    ['floor', 'SecretPIN1234', 'TENANT_ROOM_FLOOR_INVALID'],
    ['accessibility', ['\u13e2\u13aa\u13da\u13da\u13b3\u13be\u13a1\u13a0 Sommer2026'],
      'TENANT_ROOM_ACCESSIBILITY_INVALID'],
    ['floor', 'Door@c0de 1234', 'TENANT_ROOM_FLOOR_INVALID'],
    ['accessibility', ['API$k3y abc123'], 'TENANT_ROOM_ACCESSIBILITY_INVALID'],
    ['floor', '\u13e2\u13c6\u13c1 1234', 'TENANT_ROOM_FLOOR_INVALID'],
    ['floor', 'https://internal.example.test/floor', 'TENANT_ROOM_FLOOR_INVALID'],
    ['floor', 'North\u202e2', 'TENANT_ROOM_FLOOR_INVALID'],
    ['accessibility', ['Password sunshine'], 'TENANT_ROOM_ACCESSIBILITY_INVALID'],
  ]) {
    const disclosed = { ...initial.configuration,
      rooms: initial.configuration.rooms.map((room) => ({ ...room, [field]: disclosure })) };
    await assert.rejects(update(disclosed, 1), new RegExp(code));
  }
  assert.deepEqual(await repository.current(TENANT_A, { schemaVersion: 2 }), initial);
  const configured = { ...initial.configuration,
    sites: initial.configuration.sites.map((site) => ({ ...site, guestInformation: guest })) };
  await update(configured, 1);
  assert.deepEqual((await repository.current(TENANT_A, { schemaVersion: 2 })).configuration.sites[0].guestInformation, guest);
  assert.equal((await repository.current(TENANT_B, { schemaVersion: 2 })).configuration.sites[0].guestInformation, null);
  assert.equal(Object.hasOwn((await repository.current(TENANT_A)).configuration.sites[0], 'guestInformation'), false);
  assert.equal(Object.hasOwn((await repository.revision(TENANT_A, 2)).configuration.sites[0], 'guestInformation'), false);
  assert.deepEqual((await repository.revision(TENANT_A, 2, { schemaVersion: 2 })).configuration.sites[0].guestInformation, guest);

  const historical = await pool.query(`SELECT configuration, guest_information
    FROM tenant_location_revisions WHERE tenant_id=$1 AND revision=1`, [TENANT_A]);
  const unsafeHistoricalGuests = {
    'same-site': { ...guest, arrival: 'D-o-o-\u0433 code 1234' },
  };
  await pool.query(`ALTER TABLE tenant_location_revisions
    DISABLE TRIGGER tenant_location_revisions_immutable_update`);
  try {
    await pool.query(`UPDATE tenant_location_revisions SET guest_information=$3::jsonb
      WHERE tenant_id=$1 AND revision=$2`, [TENANT_A, 1, JSON.stringify(unsafeHistoricalGuests)]);
  } finally {
    await pool.query(`ALTER TABLE tenant_location_revisions
      ENABLE TRIGGER tenant_location_revisions_immutable_update`);
  }
  await assert.rejects(
    repository.revision(TENANT_A, 1, { schemaVersion: 2 }),
    /TENANT_SITE_GUEST_INFORMATION_INVALID/,
  );
  await assert.rejects(rollback(2, 1, 2), /TENANT_SITE_GUEST_INFORMATION_INVALID/);
  await pool.query(`ALTER TABLE tenant_location_revisions
    DISABLE TRIGGER tenant_location_revisions_immutable_update`);
  try {
    await pool.query(`UPDATE tenant_location_revisions SET guest_information=$3::jsonb
      WHERE tenant_id=$1 AND revision=$2`, [TENANT_A, 1, JSON.stringify(historical.rows[0].guest_information)]);
  } finally {
    await pool.query(`ALTER TABLE tenant_location_revisions
      ENABLE TRIGGER tenant_location_revisions_immutable_update`);
  }
  const unsafeHistorical = structuredClone(historical.rows[0].configuration);
  unsafeHistorical.rooms[0].accessibility = ['D.o.o.\u0433 c\u0585de 1234'];
  await pool.query(`ALTER TABLE tenant_location_revisions
    DISABLE TRIGGER tenant_location_revisions_immutable_update`);
  try {
    await pool.query(`UPDATE tenant_location_revisions SET configuration=$3::jsonb
      WHERE tenant_id=$1 AND revision=$2`, [TENANT_A, 1, JSON.stringify(unsafeHistorical)]);
  } finally {
    await pool.query(`ALTER TABLE tenant_location_revisions
      ENABLE TRIGGER tenant_location_revisions_immutable_update`);
  }
  const legacyRoomRevision = await repository.revision(TENANT_A, 1);
  assert.deepEqual(legacyRoomRevision.configuration.rooms[0].accessibility,
    ['D.o.o.\u0433 c\u0585de 1234']);
  await assert.rejects(rollback(2, 1, 2), /TENANT_ROOM_ACCESSIBILITY_INVALID/);
  assert.equal((await repository.current(TENANT_A, { schemaVersion: 2 })).revision, 2);
  await pool.query(`ALTER TABLE tenant_location_revisions
    DISABLE TRIGGER tenant_location_revisions_immutable_update`);
  try {
    await pool.query(`UPDATE tenant_location_revisions SET configuration=$3::jsonb
      WHERE tenant_id=$1 AND revision=$2`, [TENANT_A, 1, JSON.stringify(historical.rows[0].configuration)]);
  } finally {
    await pool.query(`ALTER TABLE tenant_location_revisions
      ENABLE TRIGGER tenant_location_revisions_immutable_update`);
  }
  assert.equal((await repository.revision(TENANT_A, 1)).revision, 1);
  const legacy = await repository.current(TENANT_A);
  await update(legacy.configuration, 2, 1);
  await rollback(3, 1, 1);
  assert.deepEqual((await repository.current(TENANT_A, { schemaVersion: 2 })).configuration.sites[0].guestInformation, guest);
  await rollback(4, 1, 2);
  assert.equal((await repository.current(TENANT_A, { schemaVersion: 2 })).configuration.sites[0].guestInformation, null);
  await rollback(5, 2, 2);
  assert.deepEqual((await repository.current(TENANT_A, { schemaVersion: 2 })).configuration.sites[0].guestInformation, guest);
  assert.equal((await update(configured, 1)).status, 'conflict');
  const beforeFailure = await repository.current(TENANT_A, { schemaVersion: 2 });
  failAudit = true;
  await assert.rejects(update({ ...configured, sites: configured.sites.map((site) => ({ ...site, guestInformation: null })) }, 6),
    /AUDIT_TEST_FAILURE/);
  failAudit = false;
  assert.deepEqual(await repository.current(TENANT_A, { schemaVersion: 2 }), beforeFailure);
  assert.equal(await repository.revision(TENANT_A, 7), null);

  // A real SQL read binds all three identifiers plus state; colliding Room/Site IDs stay scoped.
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await pool.query(`INSERT INTO requests(tenant_id,id,requester_user_id,room_id,status,starts_at,ends_at)
      VALUES($1,'same-request',$2,'same-room','Confirmed','2031-01-01T10:00:00Z','2031-01-01T11:00:00Z')`,
    [tenantId, USER]);
  }
  const requests = createPostgresRequestRepository(pool, {
    auditRepository,
    calendarAuthorityGuard: {
      async lockCurrent() { throw new Error('UNEXPECTED_CALENDAR_LOOKUP'); },
      async completePreConfirmationCleanup() { throw new Error('UNEXPECTED_CALENDAR_CLEANUP'); },
    },
  });
  assert.deepEqual((await requests.findGuestContextByTenantIdAndRequest(TENANT_A, 'same-request', 1)).guestPresentation, publicGuest);

  const unsafeCurrentGuest = { ...guest, arrival: 'P\u0251ssword: Sommer2026' };
  await pool.query('UPDATE sites SET guest_information=$2::jsonb WHERE tenant_id=$1 AND id=\'same-site\'',
    [TENANT_A, JSON.stringify(unsafeCurrentGuest)]);
  await assert.rejects(
    repository.current(TENANT_A, { schemaVersion: 2 }),
    /TENANT_SITE_GUEST_INFORMATION_INVALID/,
  );
  await assert.rejects(
    requests.findGuestContextByTenantIdAndRequest(TENANT_A, 'same-request', 1),
    /TENANT_SITE_GUEST_INFORMATION_INVALID/,
  );
  await pool.query('UPDATE sites SET guest_information=$2::jsonb WHERE tenant_id=$1 AND id=\'same-site\'',
    [TENANT_A, JSON.stringify(guest)]);

  for (const details of [
    { floor: 'Door code 1234' },
    { floor: 'Doo\u0433 code 1234' },
    { accessibility: ['Door c\u0585de 1234'] },
    { floor: 'D-o-o-\u0433 code 1234' },
    { accessibility: ['D.o.o.\u0433 c\u0585de 1234'] },
    { floor: 'Doorcode1234' },
    { accessibility: ['PasswortSommer2026'] },
    { floor: 'P\u0251ssword: Sommer2026' },
    { accessibility: ['PASSWORDSecret'] },
    { floor: 'https://internal.example.test/floor' },
    { floor: 'North\u202e2' },
    { accessibility: ['Password sunshine'] },
  ]) {
    await pool.query('UPDATE rooms SET details=$2::jsonb WHERE tenant_id=$1 AND id=\'same-room\'',
      [TENANT_A, JSON.stringify(details)]);
    const retained = await repository.current(TENANT_A, { schemaVersion: 2 });
    assert.equal(retained.revision, 6);
    const legacyRoom = retained.configuration.rooms.find((room) => room.id === 'same-room');
    assert.equal(legacyRoom.floor, details.floor ?? null);
    assert.deepEqual(legacyRoom.accessibility, details.accessibility ?? []);
    await assert.rejects(
      requests.findGuestContextByTenantIdAndRequest(TENANT_A, 'same-request', 1),
      /REQUEST_ROOM_GUEST_PRESENTATION_INVALID/,
    );
  }
  await pool.query("UPDATE rooms SET details='{}'::jsonb WHERE tenant_id=$1 AND id='same-room'", [TENANT_A]);
  assert.equal((await repository.current(TENANT_A, { schemaVersion: 2 })).revision, 6);
  assert.equal((await repository.current(TENANT_B, { schemaVersion: 2 })).revision, 1);
  assert.deepEqual((await requests.findGuestContextByTenantIdAndRequest(TENANT_A, 'same-request', 1)).guestPresentation, publicGuest);
  assert.equal((await requests.findGuestContextByTenantIdAndRequest(TENANT_B, 'same-request', 1)).guestPresentation, null);
  assert.equal(await requests.findGuestContextByTenantIdAndRequest(TENANT_A, 'missing', 1), null);
  assert.equal(await requests.findGuestContextByTenantIdAndRequest(TENANT_A, 'same-request', 2), null);
  await pool.query("UPDATE rooms SET active=false WHERE tenant_id=$1", [TENANT_A]);
  await pool.query("UPDATE sites SET active=false WHERE tenant_id=$1", [TENANT_A]);
  assert.equal((await requests.findGuestContextByTenantIdAndRequest(TENANT_A, 'same-request', 1)).room.active, false);
  await pool.query("UPDATE requests SET status='Cancelled' WHERE tenant_id=$1 AND id='same-request'", [TENANT_A]);
  assert.equal(await requests.findGuestContextByTenantIdAndRequest(TENANT_A, 'same-request', 1), null);
  assert.equal((await requests.findRoomContextByTenantIdAndRoomId(TENANT_A, 'same-room')).room.active, false);
});
