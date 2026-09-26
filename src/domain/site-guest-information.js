const TEXT_LIMITS = Object.freeze({
  publicTransport: 600,
  arrival: 600,
  parking: 600,
  reception: 600,
  building: 600,
  visitorNotes: 1_200,
  accessibility: 600,
});
const INFORMATION_KEYS = Object.freeze([
  'address', ...Object.keys(TEXT_LIMITS), 'wifiPolicy', 'wifiNetworkName', 'contact', 'routeUrl',
]);
const WIFI_POLICIES = new Set(['open', 'credentials_on_arrival', 'contact_organizer', 'not_available']);
const ROUTE_MAX_LENGTH = 2_048;
const NETWORK_NAME_MAX_LENGTH = 64;
const ROUTE_ORIGINS = new Set([
  'https://www.google.com',
  'https://maps.google.com',
  'https://www.openstreetmap.org',
  'https://maps.apple.com',
]);
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const MARKUP = /[<>`*\[\]~]|(?:^|\s)_[^\s_]+_|^(?:#{1,6}|[-+]|\d+[.)])\s/u;
const EMBEDDED_URI = /(?:[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|vbscript|file|blob):)/iu;
const CREDENTIAL_LABELS = Object.freeze([
  ['password'], ['passwort'], ['passphrase'], ['pass', 'phrase'], ['passcode'], ['pwd'],
  ['kennwort'], ['geheimwort'], ['psk'], ['pin'], ['credential'], ['credentials'],
  ['zugangsdaten'], ['anmeldedaten'], ['voucher'], ['voucher', 'code'], ['voucher', 'pin'],
  ['door', 'code'], ['access', 'code'], ['entry', 'code'], ['entrance', 'code'], ['gate', 'code'],
  ['turcode'], ['tuercode'], ['zugangscode'], ['einlasscode'], ['recovery', 'code'],
  ['backup', 'code'], ['verification', 'code'], ['security', 'code'], ['one', 'time', 'code'],
  ['mfa', 'code'], ['otp'], ['one', 'time', 'password'],
  ['wifi', 'password'], ['wifi', 'passwort'], ['wifi', 'key'], ['wifi', 'code'],
  ['wifi', 'passcode'], ['wifi', 'secret'], ['wlan', 'passwort'], ['wlan', 'kennwort'],
  ['wlan', 'key'], ['wlan', 'code'], ['wlan', 'passcode'], ['wlan', 'secret'],
  ['wlan', 'schlussel'], ['wlan', 'schluessel'], ['network', 'key'], ['network', 'code'],
  ['netzwerk', 'schlussel'], ['netzwerk', 'schluessel'], ['security', 'key'], ['secret', 'key'],
  ['private', 'key'], ['api', 'key'], ['access', 'key'], ['client', 'secret'], ['api', 'token'],
  ['auth', 'token'], ['bearer', 'token'], ['access', 'token'], ['refresh', 'token'],
  ['csrf', 'token'], ['secret', 'token'], ['session', 'id'], ['session', 'cookie'],
]);
const CREDENTIAL_CONFUSABLES = Object.freeze({
  '@': 'a', '$': 's', 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't',
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x',
  '\u0443': 'y', '\u0456': 'i', '\u0458': 'j', '\u043a': 'k', '\u043c': 'm', '\u0442': 't', '\u051d': 'w',
  '\u0432': 'b', '\u0433': 'r', '\u043d': 'h', '\u0455': 's', '\u0501': 'd',
  '\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e', '\u03b9': 'i', '\u03ba': 'k', '\u03bf': 'o',
  '\u03c1': 'p', '\u03c3': 's', '\u03c2': 's', '\u03c4': 't', '\u03c5': 'y', '\u03c7': 'x',
  '\u03c9': 'w', '\u0585': 'o', '\u00df': 'ss',
  '\u0131': 'i', '\u0250': 'a', '\u0251': 'a', '\u0261': 'g', '\u0269': 'i', '\u026a': 'i',
  '\u0274': 'n', '\u0275': 'o', '\u0280': 'r', '\u028f': 'y', '\u0299': 'b', '\u029f': 'l',
  '\u1d00': 'a', '\u1d04': 'c', '\u1d05': 'd', '\u1d07': 'e', '\u1d0a': 'j', '\u1d0b': 'k',
  '\u1d0d': 'm', '\u1d0f': 'o', '\u1d18': 'p', '\u1d1b': 't', '\u1d20': 'v', '\u1d21': 'w',
  '\ua7a9': 's', '\u00f8': 'o',
  '\uabb2': 'p', '\uab7a': 'a', '\uabaa': 's', '\uab83': 'w', '\uab8e': 'o', '\uab71': 'r', '\uab70': 'd',
  '\uab96': 'i', '\uab91': 'n',
});
const CREDENTIAL_LABEL_DESCRIPTORS = Object.freeze(CREDENTIAL_LABELS.map((words) => {
  const compact = words.join('');
  return Object.freeze({ compact, strict: compact.length >= 6 });
}));
const CREDENTIAL_LABEL_INITIALS = new Set(CREDENTIAL_LABEL_DESCRIPTORS.map(({ compact }) => compact[0]));
const LETTER = /\p{L}/u;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const ASCII_LATIN_LETTER = /[A-Za-z]/u;
const NON_ASCII_LETTER = /(?=[^\x00-\x7f])\p{L}/u;
const NON_ASCII_LATIN_LETTER = /(?=[^\x00-\x7f])\p{Script=Latin}/u;
const UPPERCASE_LETTER = /[\p{Lu}\p{Lt}]/u;
const LOWERCASE_LETTER = /\p{Ll}/u;
const NUMBER = /\p{N}/u;
const CREDENTIAL_DIGIT_BOUNDARY = '\u0000';
const LITERAL_PASSWORDLESS = /(?<![\p{L}\p{N}])passwordless(?=$|[^\p{L}\p{N}])/giu;

export class SiteGuestInformationInputError extends Error {
  constructor() {
    super('TENANT_SITE_GUEST_INFORMATION_INVALID');
    this.name = 'SiteGuestInformationInputError';
    this.code = 'TENANT_SITE_GUEST_INFORMATION_INVALID';
  }
}

function invalidInformation() {
  throw new SiteGuestInformationInputError();
}

function credentialSkeleton(value, preserveSeparators = false) {
  let skeleton = '';
  for (const character of value) {
    const lower = character.toLowerCase();
    const mapped = preserveSeparators && (character === '@' || character === '$')
      ? null : Object.hasOwn(CREDENTIAL_CONFUSABLES, lower)
      ? CREDENTIAL_CONFUSABLES[lower]
      : null;
    if (NUMBER.test(character)) {
      skeleton += `${CREDENTIAL_DIGIT_BOUNDARY}${mapped ?? character}${CREDENTIAL_DIGIT_BOUNDARY}`;
    } else if (mapped !== null) {
      skeleton += UPPERCASE_LETTER.test(character) ? mapped.toUpperCase() : mapped;
    } else {
      skeleton += character;
    }
  }
  return skeleton;
}

function credentialLabelMatch(characters, start, descriptor) {
  let index = start;
  let exactCharacters = 0;
  let otherWildcardCount = 0;
  for (let expectedIndex = 0; expectedIndex < descriptor.compact.length; expectedIndex += 1) {
    if (expectedIndex > 0) {
      while (index < characters.length && !ALPHANUMERIC.test(characters[index])) index += 1;
    }
    const character = characters[index];
    if (!character) return null;
    if (character.toLowerCase() === descriptor.compact[expectedIndex]) {
      if (ASCII_LATIN_LETTER.test(character)) exactCharacters += 1;
    } else if (NON_ASCII_LETTER.test(character)) {
      if (!NON_ASCII_LATIN_LETTER.test(character)) otherWildcardCount += 1;
    } else {
      return null;
    }
    index += 1;
  }
  const credible = otherWildcardCount === 0
    || (otherWildcardCount === 1 && exactCharacters >= 2);
  return { credible, end: index };
}

function startsWithWord(characters, start, word) {
  for (let offset = 0; offset < word.length; offset += 1) {
    if (characters[start + offset]?.toLowerCase() !== word[offset]) return false;
  }
  return true;
}

function isLiteralPasswordless(characters, start, end, allowLiteralPasswordless) {
  if (!allowLiteralPasswordless
    || (start > 0 && ALPHANUMERIC.test(characters[start - 1]))
    || characters.slice(start, end).join('').toLowerCase() !== 'password'
    || !startsWithWord(characters, end, 'less')) return false;
  const nextCharacter = characters[end + 4];
  return !nextCharacter || (nextCharacter !== CREDENTIAL_DIGIT_BOUNDARY
    && !ALPHANUMERIC.test(nextCharacter));
}

function hasGluedIntroducer(characters, start) {
  for (const introducer of ['lautet', 'is']) {
    if (!startsWithWord(characters, start, introducer)) continue;
    const nextCharacter = characters[start + introducer.length];
    if (!nextCharacter || !LETTER.test(nextCharacter) || UPPERCASE_LETTER.test(nextCharacter)) return true;
  }
  return false;
}

function credibleEmbeddedCredentialStart(characters, start, descriptor, match) {
  const previousCharacter = characters[start - 1];
  if (!previousCharacter || !ALPHANUMERIC.test(previousCharacter)) return true;
  if (descriptor.strict) return true;
  if (LOWERCASE_LETTER.test(previousCharacter) && UPPERCASE_LETTER.test(characters[start])) return true;
  const nextCharacter = characters[match.end];
  return nextCharacter === CREDENTIAL_DIGIT_BOUNDARY
    || (nextCharacter !== undefined && NUMBER.test(nextCharacter));
}

function couldStartCredentialLabel(characters, start) {
  const character = characters[start];
  if (ASCII_LATIN_LETTER.test(character)) return CREDENTIAL_LABEL_INITIALS.has(character.toLowerCase());
  if (!NON_ASCII_LETTER.test(character)) return false;
  if (NON_ASCII_LATIN_LETTER.test(character)) return true;
  let next = start + 1;
  while (next < characters.length && !ALPHANUMERIC.test(characters[next])) next += 1;
  return next < characters.length && ASCII_LATIN_LETTER.test(characters[next]);
}

function containsCredentialInSkeleton(value, allowLiteralPasswordless) {
  const characters = [...value];
  for (let start = 0; start < characters.length; start += 1) {
    if (!couldStartCredentialLabel(characters, start)) continue;
    for (const descriptor of CREDENTIAL_LABEL_DESCRIPTORS) {
      const match = credentialLabelMatch(characters, start, descriptor);
      if (!match?.credible || !credibleEmbeddedCredentialStart(characters, start, descriptor, match)) continue;
      const nextCharacter = characters[match.end];
      if (!nextCharacter || !ALPHANUMERIC.test(nextCharacter)) return true;
      if (UPPERCASE_LETTER.test(nextCharacter)) return true;
      if (descriptor.strict && LETTER.test(nextCharacter)) {
        if (isLiteralPasswordless(characters, start, match.end, allowLiteralPasswordless)) continue;
        return true;
      }
      if (hasGluedIntroducer(characters, match.end)) return true;
    }
  }
  return false;
}

export function containsPublicCredentialLabel(value) {
  const decomposed = value.normalize('NFKD').replace(/\p{M}/gu, '');
  if (containsCredentialInSkeleton(decomposed, true)) return true;
  const skeletonSource = decomposed.replace(LITERAL_PASSWORDLESS, (match) => 'q'.repeat(match.length));
  // @/$ can be separators in a multi-word label while other characters in
  // that same label are leet digits. The full skeleton treats them as letters.
  const separatorSkeleton = credentialSkeleton(skeletonSource, true);
  if (separatorSkeleton !== skeletonSource && containsCredentialInSkeleton(separatorSkeleton, false)) return true;
  const skeleton = credentialSkeleton(skeletonSource);
  return skeleton !== skeletonSource && skeleton !== separatorSkeleton
    && containsCredentialInSkeleton(skeleton, false);
}

export function hasUnsafePublicPresentationControl(value) {
  return CONTROL_CHARACTERS.test(value);
}

export function hasUnsafeGuestRoomText(value) {
  return CONTROL_CHARACTERS.test(value)
    || /[<>]/u.test(value)
    || EMBEDDED_URI.test(value)
    || containsPublicCredentialLabel(value);
}

function hasUnsafeSiteGuestText(value) {
  return MARKUP.test(value) || hasUnsafeGuestRoomText(value);
}

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidInformation();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidInformation();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) invalidInformation();
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalidInformation();
  }
  return value;
}

function nullablePlainText(value, maximum) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum
    || hasUnsafePublicPresentationControl(value)) invalidInformation();
  const normalized = value.trim().normalize('NFC');
  if (!normalized || hasUnsafeSiteGuestText(normalized)) {
    invalidInformation();
  }
  return normalized;
}

function publicRoute(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > ROUTE_MAX_LENGTH || !/^https:\/\//iu.test(value)
    || /[\s\\?#]/u.test(value) || hasUnsafePublicPresentationControl(value)) invalidInformation();
  let route;
  try {
    route = new URL(value);
  } catch {
    invalidInformation();
  }
  const authority = value.slice(value.indexOf('://') + 3).split('/')[0].toLowerCase();
  if (route.protocol !== 'https:' || route.username || route.password || route.port || authority !== route.hostname
    || route.href.length > ROUTE_MAX_LENGTH
    || !ROUTE_ORIGINS.has(route.origin)) invalidInformation();
  if (route.origin === 'https://www.google.com' && !/^\/maps(?:\/|$)/u.test(route.pathname)) invalidInformation();
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(route.pathname);
  } catch {
    invalidInformation();
  }
  // Only a public map destination is stored. Nothing in this module fetches or previews it.
  if (/[<>`%?&#=\\]/u.test(decodedPath) || hasUnsafeGuestRoomText(decodedPath)) invalidInformation();
  return route.href;
}

function requiredPlainText(value, maximum) {
  if (value === null) invalidInformation();
  return nullablePlainText(value, maximum);
}

function normalizeAddress(value) {
  if (value === null) return null;
  const address = exactObject(value, ['line1', 'line2', 'postalCode', 'city', 'countryCode']);
  const countryCode = requiredPlainText(address.countryCode, 2);
  if (!/^[A-Z]{2}$/u.test(countryCode)) invalidInformation();
  return Object.freeze({
    line1: requiredPlainText(address.line1, 160),
    line2: nullablePlainText(address.line2, 160),
    postalCode: requiredPlainText(address.postalCode, 32),
    city: requiredPlainText(address.city, 120),
    countryCode,
  });
}

function normalizeContact(value) {
  if (value === null) return null;
  const contact = exactObject(value, ['name', 'email', 'phone']);
  return Object.freeze({
    name: requiredPlainText(contact.name, 160),
    email: nullablePlainText(contact.email, 254),
    phone: nullablePlainText(contact.phone, 64),
  });
}

export function normalizeSiteGuestInformation(value) {
  if (value === null) return null;
  const information = exactObject(value, INFORMATION_KEYS);
  const text = Object.fromEntries(Object.entries(TEXT_LIMITS).map(([key, limit]) => [
    key, nullablePlainText(information[key], limit),
  ]));
  if (!WIFI_POLICIES.has(information.wifiPolicy)) invalidInformation();
  const wifiNetworkName = nullablePlainText(information.wifiNetworkName, NETWORK_NAME_MAX_LENGTH);
  if (information.wifiPolicy === 'not_available' && wifiNetworkName !== null) invalidInformation();
  return Object.freeze({
    address: normalizeAddress(information.address),
    ...text,
    wifiPolicy: information.wifiPolicy,
    wifiNetworkName,
    contact: normalizeContact(information.contact),
    routeUrl: publicRoute(information.routeUrl),
  });
}

export function publicSiteGuestInformation(value) {
  return value === undefined ? null : normalizeSiteGuestInformation(value);
}
