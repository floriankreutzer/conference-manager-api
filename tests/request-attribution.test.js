import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRequesterAttribution,
  normalizeActionAttribution,
  normalizeAttributionDisplayName,
  normalizeAttributionSourceDisplayName,
} from '../src/domain/request-attribution.js';
import { requestActorRoleAtAction, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { encodeOpaqueCursor } from '../src/application/opaque-cursor.js';
import { normalizeApplicationRequestListQuery } from '../src/application/request-list.js';
import { normalizeRequestHistoryQuery } from '../src/application/request-history.js';
import { normalizeRequestReportQuery } from '../src/application/request-report.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const KEY = 'attribution-cursor-regression-key-long-enough';
const NOW = '2026-09-01T08:00:00.000Z';

test('API-03 attribution exposes only bounded persisted names and actual workflow roles', () => {
  assert.deepEqual(normalizeRequesterAttribution({ displayName: 'Flo' }), { displayName: 'Flo' });
  for (const roleAtAction of ['employee', 'conference_manager', null]) {
    const attribution = normalizeActionAttribution({ displayName: 'Flo', roleAtAction });
    assert.deepEqual(attribution, { displayName: 'Flo', roleAtAction });
    assert.equal(Object.isFrozen(attribution), true);
  }
  for (const displayName of [null, '', ' Flo', 'Flo ', 'Flo\nAdmin', 'x'.repeat(161)]) {
    assert.throws(() => normalizeRequesterAttribution({ displayName }), /ATTRIBUTION_INVALID/);
  }
  for (const displayName of [
    'Manager\u202eresU',
    'Zero\u200bWidth',
    'Isolate\u2066Admin\u2069',
    'Mark\u061cAdmin',
    'Soft\u00adHyphen',
    'Line\u2028Break',
    'Word\ufeffJoin',
    'C1\u0085Control',
    'High\ud800Surrogate',
    'Low\udfffSurrogate',
  ]) {
    assert.throws(() => normalizeRequesterAttribution({ displayName }), /ATTRIBUTION_INVALID/);
    assert.throws(() => normalizeActionAttribution({
      displayName, roleAtAction: 'employee',
    }), /ATTRIBUTION_INVALID/);
  }
  assert.equal(normalizeAttributionDisplayName('Jose\u0301 山田'), 'José 山田');
  assert.equal(normalizeAttributionSourceDisplayName(' José 山田 '), 'José 山田');
  assert.throws(
    () => normalizeAttributionSourceDisplayName('José 山田\ufeff'),
    /ATTRIBUTION_INVALID/,
  );
  assert.throws(
    () => normalizeAttributionSourceDisplayName('Unsafe\ud800Name'),
    /ATTRIBUTION_INVALID/,
  );
  assert.equal(normalizeAttributionDisplayName('🧑'.repeat(160)), '🧑'.repeat(160));
  assert.throws(() => normalizeAttributionDisplayName('🧑'.repeat(161)), /ATTRIBUTION_INVALID/);
  for (const key of ['tenantId', 'userId', 'email', 'providerSubject', 'sessionId', 'roles', 'active']) {
    assert.throws(() => normalizeActionAttribution({
      displayName: 'Flo', roleAtAction: 'employee', [key]: 'forbidden',
    }), /ATTRIBUTION_INVALID/);
  }
  for (const roleAtAction of ['tenant_admin', 'owner', ['employee'], undefined]) {
    assert.throws(() => normalizeActionAttribution({ displayName: 'Flo', roleAtAction }), /ATTRIBUTION_INVALID/);
  }
});

test('API-03 dual-role actions record the Manager-first authorization path, never mutable directory roles', () => {
  assert.equal(requestActorRoleAtAction(tenantAuthorizationSnapshot(['employee'])), 'employee');
  assert.equal(requestActorRoleAtAction(tenantAuthorizationSnapshot(['employee', 'conference_manager'])), 'conference_manager');
  assert.equal(requestActorRoleAtAction(tenantAuthorizationSnapshot(['employee', 'tenant_admin'])), 'employee');
  assert.equal(requestActorRoleAtAction({ roles: ['employee', 'conference_manager'], permissions: ['request:read'] }), 'employee');
});

test('API-03 pre-cutover list, history and report cursors fail closed under new purpose scopes', () => {
  for (const [purpose, read] of [
    ['application-request-list-v2', (cursor) => normalizeApplicationRequestListQuery({ limit: undefined, cursor }, {
      tenantId: TENANT, requesterUserId: null, cursorSecret: KEY, evaluatedAt: NOW,
    })],
    ['request-history-v2', (cursor) => normalizeRequestHistoryQuery({ limit: undefined, cursor }, {
      tenantId: TENANT, requestId: 'REQ-1', cursorSecret: KEY, evaluatedAt: NOW,
    })],
    ['request-report-v2', (cursor) => normalizeRequestReportQuery({
      from: NOW, to: '2026-09-02T08:00:00.000Z', limit: undefined, cursor,
    }, { tenantId: TENANT, cursorSecret: KEY, evaluatedAt: NOW })],
  ]) {
    const cursor = encodeOpaqueCursor({ version: 2 }, { secret: KEY, purpose });
    assert.throws(() => read(cursor), /CURSOR_INVALID/);
  }
});
