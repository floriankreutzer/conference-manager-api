import assert from 'node:assert/strict';
import test from 'node:test';
import { publicGuestRoomFields } from '../src/domain/request-room-guest-presentation.js';

test('guest Room fields project only bounded current presentation and managed assets', () => {
  assert.deepEqual(publicGuestRoomFields({}), {
    floor: null, accessibility: [], floorplanAssetId: null, mediaAssetIds: [],
  });
  const result = publicGuestRoomFields({ floor: '2', accessibility: ['Lift'],
    floorplanAssetId: 'floorplan-1', mediaAssetIds: ['room-1'], serviceIds: ['private-service'],
    cateringPackageIds: [], equipment: [] });
  assert.deepEqual(result, { floor: '2', accessibility: ['Lift'], floorplanAssetId: 'floorplan-1', mediaAssetIds: ['room-1'] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.accessibility), true);
});

test('guest Room fields fail closed for malformed or authority-shaped stored presentation', () => {
  const disclosures = [
    'Door code 1234', 'Password sunshine', 'https://internal.example.test/floor',
    'Doo\u0433 code 1234', 'Door c\u0585de 1234', 'D-o-o-\u0433 code 1234',
    'D.o.o.\u0433 c\u0585de 1234', 'Doorcode1234', 'Doorcode2', 'Doorcode\u0662', 'Door code1234',
    'PasswortSommer2026', 'WiFipasswordSommer2026', 'P\u0251ssword: Sommer2026',
    '\u1d18\u026a\u0274 1234', 'passwordsecret', 'doorcodeblue', 'Doo \u0433 code 1234',
    '\u0440\u0430\u0455\u0455\u051d\u043e\u0433\u0501', 'PASSWORDSecret', '1Password: Secret',
    '\u041e\u0422\u0420', '\u03a1\u0405\u039a', '\u0391\u03a1\u0399 \u039a\u0395\u03a5',
    'Door@code 1234', 'Door$code 1234', 'API@key abc123',
    'Door@c0de 1234', 'Door$c0de 1234', 'API@k3y abc123', 'API$k3y abc123',
    'GuestPassword1234', 'guestpassword1234', 'MyPasswortSommer2026',
    'MainDoorcode1234', 'OfficeDoor code 1234', 'GuestWiFipasswordSommer2026', ['Secret', 'PIN1234'].join(''),
    '\u13e2\u13aa\u13da\u13da\u13b3\u13be\u13a1\u13a0 Sommer2026',
    '\u13e2.\u13aa.\u13da.\u13da.\u13b3.\u13be.\u13a1.\u13a0 Sommer2026',
    '\u13e2\u13c6\u13c1 1234', '\u13e2.\u13c6.\u13c1 1234',
    'North\u202e1234', 'Step-free\ud800access',
  ];
  for (const details of [null, [], { token: 'secret' }, { providerId: 'provider' },
    { floor: '<script>' }, { floor: 'x'.repeat(81) },
    ...disclosures.flatMap((value) => [{ floor: value }, { accessibility: [value] }]),
    { accessibility: ['Lift', 'Lift'] }, { accessibility: ['API key abc123'] },
    { accessibility: ['Line\nBreak'] }, { mediaAssetIds: ['../image'] },
    { floorplanAssetId: 'https://images.example.invalid/map' }, { mediaAssetIds: Array(21).fill('asset') }]) {
    assert.throws(() => publicGuestRoomFields(details), /REQUEST_ROOM_GUEST_PRESENTATION_INVALID/);
  }
});

test('guest Room fields preserve public wayfinding and conventional Floor labels', () => {
  assert.deepEqual(publicGuestRoomFields({
    floor: 'Level 2', accessibility: ['Step-free entrance', 'Induction loop'],
  }), {
    floor: 'Level 2',
    accessibility: ['Step-free entrance', 'Induction loop'],
    floorplanAssetId: null,
    mediaAssetIds: [],
  });
  assert.equal(publicGuestRoomFields({ floor: '1. OG' }).floor, '1. OG');
  assert.equal(publicGuestRoomFields({ floor: 'B[1]' }).floor, 'B[1]');
  assert.equal(publicGuestRoomFields({ floor: 'Level -1' }).floor, 'Level -1');
  assert.equal(publicGuestRoomFields({ floor: 'Étage 2' }).floor, 'Étage 2');
  assert.equal(publicGuestRoomFields({ floor: 'Этаж 2' }).floor, 'Этаж 2');
  assert.equal(publicGuestRoomFields({ floor: 'Επίπεδο 2' }).floor, 'Επίπεδο 2');
  assert.equal(publicGuestRoomFields({ floor: 'Հարկ 2' }).floor, 'Հարկ 2');
  assert.equal(publicGuestRoomFields({ floor: 'Entrance 入口' }).floor, 'Entrance 入口');
  assert.equal(publicGuestRoomFields({ floor: 'Passwordless entrance' }).floor, 'Passwordless entrance');
  for (const floor of ['Pine Street 1', 'Pink parking area', 'Pinneberg', '会議室A',
    'Reception/受付', 'ホテルWiFi', 'office@例.jp', 'Gate入口', 'Door入口案内',
    'Gate入口案内', 'Access入口案内', 'Entrance入口案内', 'WiFi接続案内',
    'WLAN接続案内', 'API利用案内', 'ᎣᏏᏲ ᎠᏰᎵ',
    'Meet at Door @ reception.', 'Parking costs $5 at reception.']) {
    assert.equal(publicGuestRoomFields({ floor }).floor, floor);
  }
  assert.equal(publicGuestRoomFields({ floor: 'Информация о транспорте' }).floor,
    'Информация о транспорте');
  assert.deepEqual(publicGuestRoomFields({
    accessibility: ['Use Door 4 beside the north entrance.', 'Access ramp'],
  }).accessibility, ['Use Door 4 beside the north entrance.', 'Access ramp']);
});
