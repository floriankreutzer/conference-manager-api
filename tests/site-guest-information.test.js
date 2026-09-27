import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SiteGuestInformationInputError,
  normalizeSiteGuestInformation,
  publicSiteGuestInformation,
} from '../src/domain/site-guest-information.js';

function information(changes = {}) {
  return {
    address: null,
    publicTransport: null,
    arrival: null,
    parking: null,
    reception: null,
    building: null,
    visitorNotes: null,
    accessibility: null,
    wifiPolicy: 'not_available',
    wifiNetworkName: null,
    contact: null,
    routeUrl: null,
    ...changes,
  };
}

function address(changes = {}) {
  return { line1: 'Example Street 12', line2: null, postalCode: '10115', city: 'Berlin', countryCode: 'DE', ...changes };
}

function contact(changes = {}) {
  return { name: 'Reception', email: 'reception@example.test', phone: '+49 30 123456', ...changes };
}

function invalid(value) {
  assert.throws(() => normalizeSiteGuestInformation(value), {
    name: 'SiteGuestInformationInputError',
    message: 'TENANT_SITE_GUEST_INFORMATION_INVALID',
    code: 'TENANT_SITE_GUEST_INFORMATION_INVALID',
  });
}

test('Guest Information is an exact immutable nullable presentation value', () => {
  assert.equal(normalizeSiteGuestInformation(null), null);
  const input = information({
    address: address({ line1: '  Example Street 12  ' }),
    arrival: 'Please arrive ten minutes before the meeting.',
    publicTransport: 'U6 to the nearby station.',
    parking: 'Visitor spaces are signposted.',
    reception: 'Register at reception.',
    visitorNotes: 'Bring photo identification.',
    building: 'West building',
    accessibility: 'Step-free entrance and lift.',
    contact: contact(),
    routeUrl: 'https://www.google.com/maps/place/Berlin',
    wifiPolicy: 'credentials_on_arrival',
    wifiNetworkName: ' Guest_WiFi ',
  });
  const result = normalizeSiteGuestInformation(input);
  assert.deepEqual(Object.keys(result), Object.keys(input));
  assert.deepEqual(result.address, address());
  assert.equal(result.wifiPolicy, 'credentials_on_arrival');
  assert.equal(result.wifiNetworkName, 'Guest_WiFi');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.address), true);
  assert.equal(Object.isFrozen(result.contact), true);
  input.address.line1 = 'Changed';
  input.contact.name = 'Changed';
  assert.equal(result.address.line1, 'Example Street 12');
  assert.equal(result.contact.name, 'Reception');
});

test('Guest Information rejects every unexpected root or nested authority/credential field', () => {
  const forbidden = [
    'password', 'passphrase', 'psk', 'voucher', 'pin', 'doorCode', 'accessCode', 'token',
    'credentialUri', 'signedUrl', 'providerSubject', 'resourceId', 'sessionId', 'csrfToken',
    'tenantId', 'userId', 'price', 'permissions', 'imageUrl', '__proto__', 'constructor',
  ];
  for (const key of forbidden) {
    invalid({ ...information(), [key]: 'untrusted' });
    invalid(information({ address: address({ [key]: 'untrusted' }) }));
    invalid(information({ contact: contact({ [key]: 'untrusted' }) }));
    invalid(information({ arrival: { [key]: 'untrusted' } }));
  }
  for (const key of ['byCar', 'publicContact', 'wifi']) invalid(information({ [key]: null }));
});

test('Guest Information rejects malformed, incomplete and non-plain objects without invoking getters', () => {
  for (const value of [undefined, false, 12, 'text', [], {}, new Date(), new Map()]) invalid(value);
  for (const key of Object.keys(information())) {
    const missing = information();
    delete missing[key];
    invalid(missing);
    invalid(information({ [key]: undefined }));
  }
  invalid(Object.assign(Object.create({ tenantId: 'authority' }), information()));
  invalid({ ...information(), [Symbol('token')]: 'untrusted' });
  const hidden = information();
  Object.defineProperty(hidden, 'token', { value: 'untrusted' });
  invalid(hidden);
  const accessor = information();
  Object.defineProperty(accessor, 'address', { enumerable: true, get() { throw new Error('getter must not run'); } });
  invalid(accessor);
  assert.deepEqual(normalizeSiteGuestInformation(Object.assign(Object.create(null), information())), information());
});

test('Guest text is bounded plain text and rejects markup, controls, embedded URLs and labeled credentials', () => {
  const rejected = [
    '', '   ', 'Hello\nworld', '\tReception', 'Hello\rworld', 'Hello\u0000world', 'Hello\u007fworld',
    'Hello\u0085world', 'Hello\u202eworld', 'Hello\u200bworld', 'Hello\ufeffworld',
    '<script>alert(1)</script>', '<img src=x>', '**bold**', '*bold*', '`inline`', '[map](https://example.test)',
    '![image](data:image/png;base64,AAAA)', '# Heading', '- list entry', '_emphasis_',
    'https://example.test', 'file:///etc/passwd', 'data:text/html,example', 'javascript:alert(1)',
    'Password: example', 'PSK=example', 'Access code: example', 'CSRF token=example', 'Passwort: example',
    5, {}, [], false,
  ];
  for (const value of rejected) invalid(information({ arrival: value }));
  const limits = {
    arrival: 600, publicTransport: 600, parking: 600,
    reception: 600, visitorNotes: 1_200, building: 600, accessibility: 600,
  };
  for (const [key, maximum] of Object.entries(limits)) {
    const value = 'x'.repeat(maximum);
    assert.equal(normalizeSiteGuestInformation(information({ [key]: value }))[key], value);
    invalid(information({ [key]: `${value}x` }));
    invalid(information({ [key]: ` ${value} ` }));
  }
});

test('Guest text rejects natural and obfuscated English or German credential disclosures', () => {
  const disclosures = [
    'Door code 1234',
    'Doo\u0433 code 1234',
    'Door c\u0585de 1234',
    'D-o-o-\u0433 code 1234',
    'D.o.o.\u0433 c\u0585de 1234',
    'Doo \u0433 code 1234',
    'Door c \u0585 de 1234',
    '\u0440\u0430\u0455\u0455\u051d\u043e\u0433\u0501',
    '\u0501\u043e\u043e\u0433 \u0441\u043e\u0501\u0435',
    'Doorcode1234',
    'Doorcode2',
    'Doorcode\u0662',
    'Door code1234',
    'PasswortSommer2026',
    'WiFipasswordSommer2026',
    'p4ssw0rdSommer2026',
    'PasswortlautetSommer2026',
    'PasswordisSecret',
    'P@sswordisSecret',
    'passwordsommer2026',
    'passwordsecret',
    'doorcodeabcd',
    'doorcodeblue',
    'P\u0251ssword: Sommer2026',
    'P\u0131N 1234',
    'P\u1d00ssword',
    'P\u0250ssword',
    'Passw\u00f8rd',
    'Pa\ua7a9\ua7a9word',
    'pass\u1d21ord',
    'passw\u0275rd',
    'p\u026an',
    'p\u0269n',
    '\u1d18\u026a\u0274 1234',
    'P\u0131n1234',
    'Passwordis Secret',
    'Passwordis 1234',
    'Passwortlautet:Sommer2026',
    'PASSWORDSecret',
    'PassworDSecret',
    '1Password: Secret',
    '2026Password: Secret',
    'passwordless1',
    '2026Passwordless',
    '\u041e\u0422\u0420',
    '\u03a1\u0405\u039a',
    '\u0391\u03a1\u0399 \u039a\u0395\u03a5',
    'P\u0131Nis 1234',
    'PINlautet:Sommer2026',
    'Door@code 1234',
    'Door$code 1234',
    'API@key abc123',
    'Door@c0de 1234',
    'Door$c0de 1234',
    'API@k3y abc123',
    'API$k3y abc123',
    'GuestPassword1234',
    'guestpassword1234',
    'MyPasswortSommer2026',
    'MainDoorcode1234',
    'OfficeDoor code 1234',
    'GuestWiFipasswordSommer2026',
    ['Secret', 'PIN1234'].join(''),
    '\u13e2\u13aa\u13da\u13da\u13b3\u13be\u13a1\u13a0 Sommer2026',
    '\u13e2.\u13aa.\u13da.\u13da.\u13b3.\u13be.\u13a1.\u13a0 Sommer2026',
    '\u13e2\u13c6\u13c1 1234',
    '\u13e2.\u13c6.\u13c1 1234',
    'Passwort lautet Sommer2026',
    'Wi-Fi password Sommer2026',
    'Wi-Fi code 1234',
    'WLAN code 1234',
    'Guest WiFi code alpha',
    'API key abc123',
    'Private key abc123',
    'PWD sunshine',
    'Voucher: ABCD-1234',
    'Pass\u051dord: Sommer2026',
    'Passcode 1234',
    'Wi-Fi passcode 1234',
    'Auth token abc',
    'One-time code 1234',
    'WiFi secret abc',
    'Access key abc',
    'P-a-s-s-w-o-r-d Sommer2026',
    'p@ssw0rd S3cret2026',
    'Pаsswоrd Sommer2026',
    'Ｐａｓｓｗｏｒｄ Sommer2026',
    'Pa\u0301ssword Sommer2026',
    'Z.u.g.a.n.g.s.c.o.d.e 1234',
    'Tür-Code 1234',
    'Tuer-Code 1234',
    'WLAN-Schlüssel Sommer2026',
    'WLAN-Schluessel Sommer2026',
    'Access token abcdef123456',
  ];
  for (const value of disclosures) {
    for (const field of ['arrival', 'publicTransport', 'parking', 'reception', 'building',
      'visitorNotes', 'accessibility', 'wifiNetworkName']) {
      invalid(information({
        wifiPolicy: field === 'wifiNetworkName' ? 'open' : 'not_available',
        [field]: value,
      }));
    }
    invalid(information({ address: address({ line2: value }) }));
    invalid(information({ contact: contact({ name: value }) }));
  }
});

test('Guest text rejects unsafe Unicode classes without blocking public wayfinding names', () => {
  for (const codePoint of [
    0x0000, 0x0085, 0x00ad, 0x061c, 0x200e, 0x2028, 0x2029, 0x202e, 0x2066, 0xd800, 0xfeff,
  ]) {
    invalid(information({ arrival: 'North' + String.fromCodePoint(codePoint) + 'entrance' }));
  }
  const safe = normalizeSiteGuestInformation(information({
    arrival: 'Enter through Door 4 beside the north entrance.',
    publicTransport: 'Code Museum station is opposite the campus.',
    accessibility: 'Use the access ramp at the north entrance.',
    wifiPolicy: 'open',
    wifiNetworkName: 'Conference Guest Wi-Fi',
  }));
  assert.equal(safe.arrival, 'Enter through Door 4 beside the north entrance.');
  assert.equal(safe.publicTransport, 'Code Museum station is opposite the campus.');
  assert.equal(safe.accessibility, 'Use the access ramp at the north entrance.');
  assert.equal(safe.wifiNetworkName, 'Conference Guest Wi-Fi');
  assert.equal(normalizeSiteGuestInformation(information({
    parking: 'Collect the parking permit at reception.',
  })).parking, 'Collect the parking permit at reception.');
  assert.equal(normalizeSiteGuestInformation(information({
    arrival: '入口は北側です',
  })).arrival, '入口は北側です');
  assert.equal(normalizeSiteGuestInformation(information({
    arrival: 'Entrance 入口 is north.',
  })).arrival, 'Entrance 入口 is north.');
  assert.equal(normalizeSiteGuestInformation(information({
    arrival: 'Berlin Москва 東京',
  })).arrival, 'Berlin Москва 東京');
  assert.equal(normalizeSiteGuestInformation(information({
    arrival: 'Use the passwordless entrance.',
  })).arrival, 'Use the passwordless entrance.');
  assert.equal(normalizeSiteGuestInformation(information({
    address: address({ line1: 'улица Арбат 1', city: 'Москва' }),
  })).address.line1, 'улица Арбат 1');
  for (const arrival of [
    'Pine Street 1', 'Pink parking area', 'Pinneberg', '会議室A', 'Reception/受付',
    'ホテルWiFi', 'office@例.jp', 'Gate入口 is north.', 'Łódź', 'Œuvre',
    'Информация о транспорте', 'Door入口案内', 'Gate入口案内', 'Access入口案内',
    'Entrance入口案内', 'WiFi接続案内', 'WLAN接続案内', 'API利用案内', 'ᎣᏏᏲ ᎠᏰᎵ',
    'Meet at Door @ reception.', 'Parking costs $5 at reception.',
  ]) assert.equal(normalizeSiteGuestInformation(information({ arrival })).arrival, arrival);
  assert.equal(normalizeSiteGuestInformation(information({
    wifiPolicy: 'open',
    wifiNetworkName: 'Gäste-WLAN',
  })).wifiNetworkName, 'Gäste-WLAN');
});

test('Guest address and public contact enforce exact nested shapes, nullability and bounds', () => {
  const fixtures = { address: address(), contact: contact() };
  for (const [field, fixture] of Object.entries(fixtures)) {
    for (const key of Object.keys(fixture)) {
      const missing = { ...fixture };
      delete missing[key];
      invalid(information({ [field]: missing }));
      invalid(information({ [field]: { ...fixture, [key]: undefined } }));
    }
    for (const value of ['', [], {}, false]) invalid(information({ [field]: value }));
  }
  for (const key of ['line1', 'postalCode', 'city', 'countryCode']) invalid(information({ address: address({ [key]: null }) }));
  for (const countryCode of ['de', 'DEU', 'D1', '']) invalid(information({ address: address({ countryCode }) }));
  invalid(information({ contact: contact({ name: null }) }));
  const nestedBounds = {
    address: { line1: 160, line2: 160, postalCode: 32, city: 120 },
    contact: { name: 160, email: 254, phone: 64 },
  };
  for (const [field, limits] of Object.entries(nestedBounds)) {
    for (const [key, maximum] of Object.entries(limits)) {
      const value = { ...fixtures[field], [key]: 'x'.repeat(maximum) };
      assert.deepEqual(normalizeSiteGuestInformation(information({ [field]: value }))[field], value);
      invalid(information({ [field]: { ...value, [key]: `${value[key]}x` } }));
      invalid(information({ [field]: { ...value, [key]: 'Password: example' } }));
    }
  }
  assert.deepEqual(normalizeSiteGuestInformation(information({ contact: contact({ email: null, phone: null }) })).contact,
    contact({ email: null, phone: null }));
});

test('Guest presentation persists canonical Unicode compatible with the exact frontend reader', () => {
  const normalized = normalizeSiteGuestInformation(information({
    address: address({ city: 'Ko\u0308ln' }),
    arrival: 'Ga\u0308ste melden sich am Empfang.',
    contact: contact({ name: 'Jose\u0301' }),
    wifiPolicy: 'open',
    wifiNetworkName: 'Ga\u0308ste',
  }));
  assert.equal(normalized.address.city, 'Köln');
  assert.equal(normalized.arrival, 'Gäste melden sich am Empfang.');
  assert.equal(normalized.contact.name, 'José');
  assert.equal(normalized.wifiNetworkName, 'Gäste');
});

test('Guest Wi-Fi policy is required, closed, non-secret and checks availability with its network name', () => {
  for (const wifiPolicy of ['open', 'credentials_on_arrival', 'contact_organizer', 'not_available']) {
    assert.equal(normalizeSiteGuestInformation(information({ wifiPolicy })).wifiPolicy, wifiPolicy);
  }
  const wifiNetworkName = 'x'.repeat(64);
  assert.equal(normalizeSiteGuestInformation(information({ wifiPolicy: 'open', wifiNetworkName })).wifiNetworkName,
    wifiNetworkName);
  for (const wifiPolicy of [null, undefined, '', 'OPEN', 'password', {}, []]) invalid(information({ wifiPolicy }));
  invalid(information({ wifiPolicy: 'not_available', wifiNetworkName: 'Guest' }));
  for (const value of ['x'.repeat(65), '<img>', '', 'Password: example', {}, []]) {
    invalid(information({ wifiPolicy: 'open', wifiNetworkName: value }));
  }
});

test('Guest routes accept only bounded public HTTPS map destinations', () => {
  for (const routeUrl of [
    'https://www.google.com/maps/place/Berlin',
    'https://www.google.com/maps/dir/Berlin/Potsdam',
    'https://maps.google.com/',
    'https://www.openstreetmap.org/directions',
    'https://www.openstreetmap.org/Москва/東京',
    'https://www.openstreetmap.org/maps/place/東京タワー',
    'https://www.openstreetmap.org/maps/place/passwordless/Door4',
    'https://www.openstreetmap.org/way/Room@Reception',
    'https://www.openstreetmap.org/way/Room$Reception',
    'https://maps.apple.com/',
  ]) assert.equal(normalizeSiteGuestInformation(information({ routeUrl })).routeUrl, new URL(routeUrl).href);
  const prefix = 'https://www.google.com/maps/place/';
  const maximum = `${prefix}${'x'.repeat(2_048 - prefix.length)}`;
  assert.equal(normalizeSiteGuestInformation(information({ routeUrl: maximum })).routeUrl, maximum);
  invalid(information({ routeUrl: `${maximum}x` }));
});

test('Guest route rejection covers credentials, signed/query URLs, lookalike origins and encoded injection', () => {
  const rejected = [
    '', '/maps/place/Berlin', '//maps.google.com/', 'http://maps.google.com/',
    'javascript:alert(1)', 'data:text/html,example', 'https://user@example.test/',
    'https://user:example@maps.google.com/', 'https://maps.google.com:444/', 'https://maps.google.com:443/',
    'https:maps.google.com', 'https:/maps.google.com',
    'https://www.google.com/url', 'https://www.google.com/maps.evil/',
    'https://maps.google.com.evil.test/', 'https://maps.google.com@evil.test/',
    'https://evil.test/maps.google.com', 'https://127.0.0.1/', 'https://localhost/',
    'https://maps.google.com/?q=Berlin', 'https://maps.google.com/?token=example',
    'https://maps.google.com/?signature=example', 'https://maps.google.com/?',
    'https://maps.google.com/#Berlin', 'https://maps.google.com/#',
    'https://maps.google.com/\n', ' https://maps.google.com/',
    'https://maps.google.com/\\evil.test', 'https://maps.google.com/%0a',
    'https://maps.google.com/%3Cscript%3E', 'https://maps.google.com/%3ftoken%3dexample',
    'https://maps.google.com/https%3A%2F%2Fevil.test', 'https://maps.google.com/%',
    'https://maps.google.com/%253ftoken%253dexample',
    'https://www.openstreetmap.org/way/GuestPassword1234',
    'https://www.openstreetmap.org/way/MainDoorcode1234',
    'https://www.openstreetmap.org/way/Door@c0de1234',
    'https://www.openstreetmap.org/way/Door$c0de1234',
    'https://www.openstreetmap.org/way/API@k3y-abc123',
    'https://www.openstreetmap.org/way/API$k3y-abc123',
    'https://www.openstreetmap.org/way/\u13e2\u13c6\u13c1-1234',
    'https://www.openstreetmap.org/way/\u13e2.\u13c6.\u13c1-1234',
    'https://www.google.com/maps/../url', 15, {}, [],
  ];
  for (const routeUrl of rejected) invalid(information({ routeUrl }));
});

test('Guest credential screening stays bounded after Unicode compatibility expansion', () => {
  const startedAt = performance.now();
  const visitorNotes = '\ufdfa'.repeat(1_200);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    assert.equal(normalizeSiteGuestInformation(information({ visitorNotes })).visitorNotes, visitorNotes);
  }
  assert.ok(performance.now() - startedAt < 5_000);
});

test('Persisted Guest projection fails closed without returning partial unsafe data or mutating source', () => {
  for (const value of [null, undefined]) assert.equal(publicSiteGuestInformation(value), null);
  for (const value of [{}, information({ arrival: 'Safe', token: 'untrusted' }),
    information({ routeUrl: 'https://evil.test/' }), information({ wifiPolicy: 'password' })]) {
    assert.throws(() => publicSiteGuestInformation(value), SiteGuestInformationInputError);
  }
  assert.deepEqual(publicSiteGuestInformation(information()), information());
  const input = information({ arrival: 'Use reception.' });
  assert.deepEqual(publicSiteGuestInformation(input), information());
  assert.equal(input.arrival, 'Use reception.');
  const unlabeledCode = information({ arrival: 'At the entrance, enter 7421.' });
  assert.equal(publicSiteGuestInformation(unlabeledCode).arrival, null);
  assert.equal(unlabeledCode.arrival, 'At the entrance, enter 7421.');
  assert.notEqual(publicSiteGuestInformation(input), input);
  assert.deepEqual(publicSiteGuestInformation(information({ wifiPolicy: 'not_available' })),
    information({ wifiPolicy: 'not_available' }));
  assert.equal(new SiteGuestInformationInputError().message, 'TENANT_SITE_GUEST_INFORMATION_INVALID');
});
