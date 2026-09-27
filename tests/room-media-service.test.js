import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createRoomMediaService } from '../src/application/room-media-service.js';
import { createAuthorizationPolicy, PERMISSION, TENANT_ROLE } from '../src/authorization/policy.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ASSET = '44444444-4444-4444-8444-444444444444';
const tenantContext = { tenantId: TENANT };

function principal(role, tenantId = TENANT) {
  return {
    userId: USER,
    tenantId,
    roles: [role],
    permissions: role === TENANT_ROLE.CONFERENCE_MANAGER
      ? [PERMISSION.REQUEST_READ, PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE]
      : [PERMISSION.REQUEST_READ],
  };
}

function harness() {
  const calls = [];
  const repository = {
    async create(input) {
      calls.push({ type: 'create', input });
      return { status: 'created', assetId: ASSET };
    },
    async findAttached(input) {
      calls.push({ type: 'read', input });
      return { bytes: Buffer.from('webp'), contentType: 'image/webp' };
    },
  };
  return {
    calls,
    service: createRoomMediaService({
      repository,
      authorizationPolicy: createAuthorizationPolicy(),
      auditService: { createEvent(input) { return input; } },
    }),
  };
}

test('Room imagery denies employees and other Tenants before decoding or persistence', async () => {
  const { calls, service } = harness();
  const bytes = Buffer.from('invalid');
  await assert.rejects(service.upload({
    principal: principal(TENANT_ROLE.EMPLOYEE), tenantContext, roomId: 'room-a',
    bytes, contentType: 'image/png',
  }), /PERMISSION_REQUIRED/);
  await assert.rejects(service.upload({
    principal: principal(TENANT_ROLE.CONFERENCE_MANAGER, OTHER_TENANT), tenantContext,
    roomId: 'room-a', bytes, contentType: 'image/png',
  }), /TENANT_SCOPE_INVALID/);
  await assert.rejects(service.read({
    principal: principal(TENANT_ROLE.EMPLOYEE, OTHER_TENANT), tenantContext,
    roomId: 'room-a', assetId: ASSET,
  }), /TENANT_SCOPE_INVALID/);
  assert.deepEqual(calls, []);
});

test('manager uploads sanitized WebP and reads inactive attachments; employee reads active only', async () => {
  const { calls, service } = harness();
  const bytes = await sharp({ create: {
    width: 2, height: 3, channels: 3, background: '#ee4040',
  } }).jpeg().withExif({ IFD0: { Copyright: 'private-data' } }).toBuffer();
  assert.deepEqual(await service.upload({
    principal: principal(TENANT_ROLE.CONFERENCE_MANAGER), tenantContext,
    correlationId: ASSET, roomId: 'room-a', bytes, contentType: 'image/jpeg',
  }), { status: 'created', assetId: ASSET });
  assert.equal(calls[0].input.tenantId, TENANT);
  assert.equal(calls[0].input.roomId, 'room-a');
  assert.equal(calls[0].input.image.contentType, 'image/webp');
  assert.equal((await sharp(calls[0].input.image.bytes).metadata()).exif, undefined);
  const audit = calls[0].input.auditEvent(ASSET);
  assert.equal(audit.newState.byteLength, calls[0].input.image.bytes.length);
  assert.equal(audit.newState.roomId, 'room-a');
  await service.read({
    principal: principal(TENANT_ROLE.EMPLOYEE), tenantContext, roomId: 'room-a', assetId: ASSET,
  });
  await service.read({
    principal: principal(TENANT_ROLE.CONFERENCE_MANAGER), tenantContext, roomId: 'room-a', assetId: ASSET,
  });
  assert.equal(calls[1].input.includeInactive, false);
  assert.equal(calls[2].input.includeInactive, true);
});
