import { normalizeSiteGuestInformation } from '../domain/site-guest-information.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeTenantCatalogue } from '../domain/tenant-catalogue.js';

import {
  TENANT_ROLE,
  tenantAuthorizationSnapshot,
} from '../authorization/policy.js';
import {
  DEMO_RUNTIME_SCHEMA_VERSION,
  DEMO_SEED_VERSION,
} from './runtime-contract.js';

const CHECKSUM_DOMAIN = 'conference-manager:demo-baseline:v1\0';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESOURCE_ADDRESS_PATTERN = /^[^@\s]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 20_000;
const MAX_CANONICAL_BYTES = 1_000_000;
const DEMO_PLATFORM_ROLE = Object.freeze({
  SUPPORT_READER: 'platform_support_reader',
  TENANT_OPERATOR: 'platform_tenant_operator',
  SECURITY_AUDITOR: 'platform_security_auditor',
  SECURITY_ADMIN: 'platform_security_admin',
});
const KNOWN_DEMO_PLATFORM_ROLES = new Set(Object.values(DEMO_PLATFORM_ROLE));

export class DemoFixtureError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DemoFixtureError';
    this.code = code;
  }
}

function fail(code) {
  throw new DemoFixtureError(code);
}

function exactKeys(value, requiredKeys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...requiredKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function string(value, code, { min = 1, max = 160, pattern } = {}) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < min
    || value.length > max
    || (pattern && !pattern.test(value))
    || /[\u0000-\u001f\u007f]/.test(value)
  ) fail(code);
  return value;
}

function integer(value, code, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail(code);
  return value;
}

function utcInstant(value, code) {
  string(value, code, { max: 32 });
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(code);
  return value;
}

function unique(values, code) {
  if (new Set(values).size !== values.length) fail(code);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function canonicalize(value, state, depth = 0) {
  state.nodes += 1;
  if (depth > MAX_CANONICAL_DEPTH || state.nodes > MAX_CANONICAL_NODES) {
    fail('DEMO_FIXTURE_CHECKSUM_BOUNDS_EXCEEDED');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('DEMO_FIXTURE_CHECKSUM_VALUE_INVALID');
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => canonicalize(entry, state, depth + 1))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('DEMO_FIXTURE_CHECKSUM_VALUE_INVALID');
  }
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('DEMO_FIXTURE_CHECKSUM_VALUE_INVALID');
    normalized[key] = canonicalize(value[key], state, depth + 1);
  }
  return normalized;
}

export function semanticChecksum(value) {
  const json = JSON.stringify(canonicalize(value, { nodes: 0 }));
  if (Buffer.byteLength(json) > MAX_CANONICAL_BYTES) fail('DEMO_FIXTURE_CHECKSUM_BOUNDS_EXCEEDED');
  return createHash('sha256').update(CHECKSUM_DOMAIN).update(json).digest('hex');
}

export function assertSemanticChecksum(value, expectedChecksum) {
  string(expectedChecksum, 'DEMO_FIXTURE_CHECKSUM_INVALID', { min: 64, max: 64, pattern: CHECKSUM_PATTERN });
  const actual = semanticChecksum(value);
  if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedChecksum, 'hex'))) {
    fail('DEMO_FIXTURE_CHECKSUM_MISMATCH');
  }
  return actual;
}

function customerPersona({ tenantId, persona, userId, roles, providerSubject }) {
  const snapshot = tenantAuthorizationSnapshot(roles);
  return {
    tenantId,
    persona,
    userId,
    securityVersion: 1,
    roles: snapshot.roles,
    permissions: snapshot.permissions,
    providerIdentity: {
      provider: 'demo_customer',
      reference: providerSubject,
    },
  };
}

function platformPersona({ persona, operatorId, roles, tenantIds, providerSubject, assuranceLevel }) {
  const securityVersion = (tenantIds?.length || 0) + 1;
  const targetScope = {
    mode: tenantIds === null ? 'all' : 'allowlist',
    securityVersion,
  };
  return {
    persona,
    operatorId,
    securityVersion,
    roles,
    tenantIds: tenantIds || [],
    targetScope,
    providerIdentity: {
      provider: 'demo_platform',
      tenantReference: 'shared-demo-platform',
      subjectReference: providerSubject,
    },
    assurance: {
      level: assuranceLevel,
      authenticationContext: `demo:${assuranceLevel}`,
    },
  };
}

function guestInformation(city, countryCode) {
  return normalizeSiteGuestInformation({
    address: { line1: 'Example Campus 1', line2: null, postalCode: countryCode === 'DE' ? '10115' : '75001',
      city, countryCode },
    publicTransport: 'Use the public transport stop at the campus entrance.',
    arrival: 'Please arrive ten minutes before the meeting.',
    parking: 'Visitor parking is signposted at the main entrance.',
    reception: 'Register at the main reception.',
    building: 'Conference building',
    visitorNotes: 'Synthetic demonstration information.',
    accessibility: 'Step-free entrance and lift.',
    wifiPolicy: 'credentials_on_arrival',
    wifiNetworkName: 'Demo Guest',
    contact: { name: 'Demo Reception', email: 'reception@example.invalid', phone: null },
    routeUrl: null,
  });
}

const TENANT_A = '10000000-0000-4000-8000-000000000001';
const TENANT_B = '20000000-0000-4000-8000-000000000002';
const TENANT_C = '40000000-0000-4000-8000-000000000004';

const fixture = {
  schemaVersion: DEMO_RUNTIME_SCHEMA_VERSION,
  seedVersion: DEMO_SEED_VERSION,
  fixedClock: '2026-06-15T09:00:00.000Z',
  tenants: [
    {
      id: TENANT_A,
      displayName: 'Northwind Demo',
      lifecycleStatus: 'active',
      lifecycleRevision: 1,
      settings: {
        organization: { name: 'Northwind Demo GmbH', countryCode: 'DE' },
        locations: [{
          id: '11000000-0000-4000-8000-000000000001',
          name: 'Berlin Demo Campus',
          timeZone: 'Europe/Berlin',
          guestInformation: guestInformation('Berlin', 'DE'),
          rooms: [
            {
              "id": "northwind-berlin-room-1",
              "description": "Großzügiger Konferenzraum mit Tageslicht, variabler Bestuhlung und Videokonferenztechnik. " +
                "Geeignet für Kundenpräsentationen, Projekt-Kick-offs und bereichsübergreifende Workshops.",
              "name": "Berlin Forum",
              "capacity": 24,
              "priceMinor": 12500,
              "floor": "EG",
              "equipment": [
                "display-86",
                "video-system",
                "whiteboard",
                "wireless-mic"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-2",
              "description": "Ruhiger Besprechungsraum mit zentralem Konferenztisch, ergonomischen Stühlen und " +
                "schallgedämpften Oberflächen. Für vertrauliche Abstimmungen und hybride Entscheidungstermine.",
              "name": "Spree Boardroom",
              "capacity": 12,
              "priceMinor": 9500,
              "floor": "1. OG",
              "equipment": [
                "display-65",
                "video-system",
                "speakerphone"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-3",
              "description": "Flexibel nutzbarer Workshopraum mit mobilen Tischen, großen Schreibflächen und Platz für " +
                "Gruppenarbeit. Moderationsmaterial und mobile Pinnwände sind direkt verfügbar.",
              "name": "Workshop Loft",
              "capacity": 20,
              "priceMinor": 11000,
              "floor": "2. OG",
              "equipment": [
                "mobile-display",
                "whiteboard",
                "pinboard",
                "moderation-kit"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-4",
              "description": "Kreativraum für Ideenentwicklung, Design-Sprints und Produktarbeit. Bewegliche Möbel erlauben " +
                "den Wechsel zwischen Präsentation, Kleingruppen und gemeinsamer Ergebnissicherung.",
              "name": "Innovation Lab",
              "capacity": 16,
              "priceMinor": 10000,
              "floor": "2. OG",
              "equipment": [
                "mobile-display",
                "whiteboard",
                "pinboard",
                "moderation-kit"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-5",
              "description": "Kompakter Rückzugsraum für konzentrierte Abstimmungen und Einzelgespräche. Ein Monitor, eine " +
                "Kamera und eine einfache Tischanschlusslösung unterstützen hybride Termine.",
              "name": "Focus One",
              "capacity": 4,
              "priceMinor": 3500,
              "floor": "1. OG",
              "equipment": [
                "display-55",
                "usb-camera",
                "usb-c-dock"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-6",
              "description": "Kleiner Besprechungsraum abseits der offenen Arbeitsflächen. Für Interviews, kurze " +
                "Projektabsprachen und Videokonferenzen in kleiner Runde.",
              "name": "Focus Two",
              "capacity": 4,
              "priceMinor": 3500,
              "floor": "1. OG",
              "equipment": [
                "display-55",
                "usb-camera",
                "speakerphone"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-7",
              "description": "Schulungsraum mit Reihen- und Gruppenbestuhlung, guter Sicht auf die Präsentationsfläche und " +
                "zusätzlichen Stromanschlüssen. Für Trainings, Einführungsveranstaltungen und ganztägige " +
                "Seminare.",
              "name": "Training Campus",
              "capacity": 36,
              "priceMinor": 16000,
              "floor": "EG",
              "equipment": [
                "projector",
                "projection-screen",
                "wireless-mic",
                "flipchart"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-8",
              "description": "Besprechungsbereich mit komfortabler Sitzgruppe und einem separaten Arbeitstisch. Geeignet für " +
                "kleine Kundengespräche, Interviews und Strategieabstimmungen.",
              "name": "Executive Lounge",
              "capacity": 8,
              "priceMinor": 9000,
              "floor": "3. OG",
              "equipment": [
                "display-65",
                "video-system",
                "speakerphone"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-9",
              "description": "Großer Veranstaltungsraum mit Bühne, Präsentationsfläche und Mikrofontechnik. Die " +
                "Reihenbestuhlung unterstützt Townhalls, Informationsveranstaltungen und größere " +
                "Kundenveranstaltungen.",
              "name": "Townhall Auditorium",
              "capacity": 80,
              "priceMinor": 30000,
              "floor": "EG",
              "equipment": [
                "projector",
                "projection-screen",
                "wireless-mic",
                "presenter",
                "hearing-support"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-10",
              "description": "Raum für anspruchsvolle hybride Meetings mit mehreren Kameraperspektiven, guter " +
                "Sprachverständlichkeit und regelbarer Beleuchtung. Für externe Präsentationen und digitale " +
                "Workshops.",
              "name": "Hybrid Studio",
              "capacity": 10,
              "priceMinor": 12000,
              "floor": "3. OG",
              "equipment": [
                "display-86",
                "video-system",
                "usb-camera",
                "wireless-mic",
                "studio-light"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            }
          ],
        }],
        catalogue: {
          services: ['room', 'catering'],
          currency: 'EUR',
          equipment: [
            {
              "id": "mobile-display",
              "name": "Mobiles Präsentationsdisplay",
              "description": "Rollbares Display für Präsentationen und Gruppenarbeit.",
              "active": true,
              "order": 1,
              "price": {
                "amountMinor": 2500,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-3",
                "northwind-berlin-room-4"
              ]
            },
            {
              "id": "display-86",
              "name": "86-Zoll-Präsentationsdisplay",
              "description": "Großformatige Bildfläche für größere Konferenzräume.",
              "active": true,
              "order": 2,
              "price": {
                "amountMinor": 3500,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-1",
                "northwind-berlin-room-10"
              ]
            },
            {
              "id": "display-65",
              "name": "65-Zoll-Präsentationsdisplay",
              "description": "Präsentationsdisplay für mittelgroße Besprechungen.",
              "active": true,
              "order": 3,
              "price": {
                "amountMinor": 2200,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-2",
                "northwind-berlin-room-8"
              ]
            },
            {
              "id": "display-55",
              "name": "55-Zoll-Präsentationsdisplay",
              "description": "Kompaktes Display für kleine Gesprächsrunden.",
              "active": true,
              "order": 4,
              "price": {
                "amountMinor": 1500,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-5",
                "northwind-berlin-room-6"
              ]
            },
            {
              "id": "video-system",
              "name": "Hybrides Videokonferenzsystem",
              "description": "Kamera, Mikrofone und Lautsprecher für hybride Meetings.",
              "active": true,
              "order": 5,
              "price": {
                "amountMinor": 4500,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-1",
                "northwind-berlin-room-2",
                "northwind-berlin-room-8",
                "northwind-berlin-room-10"
              ]
            },
            {
              "id": "usb-camera",
              "name": "USB-Konferenzkamera",
              "description": "Zusätzliche Kamera für Laptop-basierte Konferenzen.",
              "active": true,
              "order": 6,
              "price": {
                "amountMinor": 1200,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-5",
                "northwind-berlin-room-6",
                "northwind-berlin-room-10"
              ]
            },
            {
              "id": "speakerphone",
              "name": "Konferenzlautsprecher",
              "description": "Tischlautsprecher mit integriertem Mikrofon.",
              "active": true,
              "order": 7,
              "price": {
                "amountMinor": 800,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-2",
                "northwind-berlin-room-6",
                "northwind-berlin-room-8"
              ]
            },
            {
              "id": "wireless-mic",
              "name": "Funkmikrofon-Set",
              "description": "Drahtloses Mikrofon für Präsentationen und Diskussionen.",
              "active": true,
              "order": 8,
              "price": {
                "amountMinor": 1800,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-1",
                "northwind-berlin-room-7",
                "northwind-berlin-room-9",
                "northwind-berlin-room-10"
              ]
            },
            {
              "id": "whiteboard",
              "name": "Mobiles Whiteboard",
              "description": "Beschreibbare Arbeitsfläche inklusive Stiften und Reinigung.",
              "active": true,
              "order": 9,
              "price": {
                "amountMinor": 1000,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-1",
                "northwind-berlin-room-3",
                "northwind-berlin-room-4"
              ]
            },
            {
              "id": "pinboard",
              "name": "Moderations-Pinnwand",
              "description": "Mobile Pinnwand für strukturierte Gruppenarbeit.",
              "active": true,
              "order": 10,
              "price": {
                "amountMinor": 800,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-3",
                "northwind-berlin-room-4"
              ]
            },
            {
              "id": "moderation-kit",
              "name": "Moderationskoffer",
              "description": "Karten, Marker, Klebepunkte und Moderationszubehör.",
              "active": true,
              "order": 11,
              "price": {
                "amountMinor": 1500,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-3",
                "northwind-berlin-room-4"
              ]
            },
            {
              "id": "projector",
              "name": "Präsentationsprojektor",
              "description": "Projektor für großflächige Präsentationen.",
              "active": true,
              "order": 12,
              "price": {
                "amountMinor": 3000,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-7",
                "northwind-berlin-room-9"
              ]
            },
            {
              "id": "projection-screen",
              "name": "Projektionsleinwand",
              "description": "Mobile oder fest installierte Präsentationsfläche.",
              "active": true,
              "order": 13,
              "price": {
                "amountMinor": 1000,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-7",
                "northwind-berlin-room-9"
              ]
            },
            {
              "id": "flipchart",
              "name": "Flipchart",
              "description": "Flipchart mit Papier und Stiften.",
              "active": true,
              "order": 14,
              "price": {
                "amountMinor": 700,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-7"
              ]
            },
            {
              "id": "usb-c-dock",
              "name": "USB-C-Anschlussstation",
              "description": "Anschlusslösung für unterstützte Präsentationsgeräte.",
              "active": true,
              "order": 15,
              "price": {
                "amountMinor": 500,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-5"
              ]
            },
            {
              "id": "presenter",
              "name": "Kabelloser Presenter",
              "description": "Fernsteuerung für Folienpräsentationen.",
              "active": true,
              "order": 16,
              "price": {
                "amountMinor": 400,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-9"
              ]
            },
            {
              "id": "hearing-support",
              "name": "Mobile Hörunterstützung",
              "description": "Zusätzliche Hörunterstützung nach vorheriger Abstimmung.",
              "active": true,
              "order": 17,
              "price": {
                "amountMinor": 2000,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-9"
              ]
            },
            {
              "id": "studio-light",
              "name": "Studio-Beleuchtungsset",
              "description": "Regelbare Beleuchtung für hybride Präsentationen.",
              "active": true,
              "order": 18,
              "price": {
                "amountMinor": 2000,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [
                "northwind-berlin-room-10"
              ]
            }
          ],
          cateringPackages: [
            {
              "id": "coffee-break",
              "name": "Kaffeepause",
              "description": "Kaffee, Tee, Wasser und Gebäck für eine kurze Besprechungspause.",
              "active": true,
              "order": 1,
              "price": {
                "amountMinor": 1200,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [],
              "itemIds": [
                "coffee-tea",
                "water-juice",
                "pastry"
              ],
              "variants": [{
                "id": "coffee-break-standard", "name": "Standard", "description": null,
                "active": true, "order": 1,
                "price": { "amountMinor": 1200, "currency": "EUR" }
              }]
            },
            {
              "id": "business-breakfast",
              "name": "Business-Frühstück",
              "description": "Getränke, Obst und vegetarische Sandwiches zum gemeinsamen Start.",
              "active": true,
              "order": 2,
              "price": {
                "amountMinor": 1800,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [],
              "itemIds": [
                "coffee-tea",
                "water-juice",
                "fruit",
                "sandwich-vegetarian"
              ],
              "variants": [{
                "id": "business-breakfast-standard", "name": "Standard", "description": null,
                "active": true, "order": 1,
                "price": { "amountMinor": 1800, "currency": "EUR" }
              }]
            },
            {
              "id": "workshop-day",
              "name": "Workshop-Tag",
              "description": "Tagesbegleitung mit Getränken, Lunch und Nachmittagssnack.",
              "active": true,
              "order": 3,
              "price": {
                "amountMinor": 4200,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [],
              "itemIds": [
                "coffee-tea",
                "water-juice",
                "lunch-classic",
                "afternoon-snack"
              ],
              "variants": [{
                "id": "workshop-day-standard", "name": "Standard", "description": null,
                "active": true, "order": 1,
                "price": { "amountMinor": 4200, "currency": "EUR" }
              }]
            },
            {
              "id": "vegan-day",
              "name": "Veganer Konferenztag",
              "description": "Pflanzliches Tagesangebot mit Obst, Getränken und veganem Lunch.",
              "active": true,
              "order": 4,
              "price": {
                "amountMinor": 3900,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": [],
              "itemIds": [
                "coffee-tea",
                "water-juice",
                "fruit",
                "lunch-vegan"
              ],
              "variants": [{
                "id": "vegan-day-standard", "name": "Standard", "description": null,
                "active": true, "order": 1,
                "price": { "amountMinor": 3900, "currency": "EUR" }
              }]
            }
          ],
          cateringItems: [
            {
              "id": "coffee-tea",
              "name": "Kaffee und Tee",
              "description": "Heißgetränke für die Besprechungspause.",
              "active": true,
              "order": 1,
              "price": {
                "amountMinor": 450,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": []
            },
            {
              "id": "water-juice",
              "name": "Wasser und Saft",
              "description": "Mineralwasser und Saftauswahl.",
              "active": true,
              "order": 2,
              "price": {
                "amountMinor": 350,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": []
            },
            {
              "id": "fruit",
              "name": "Obstauswahl",
              "description": "Portionierte saisonale Obstauswahl.",
              "active": true,
              "order": 3,
              "price": {
                "amountMinor": 450,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": []
            },
            {
              "id": "pastry",
              "name": "Gebäckauswahl",
              "description": "Kleine süße Gebäckstücke zur Kaffeepause.",
              "active": true,
              "order": 4,
              "price": {
                "amountMinor": 500,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": []
            },
            {
              "id": "sandwich-vegetarian",
              "name": "Vegetarische Sandwiches",
              "description": "Belegte Sandwiches mit vegetarischer Füllung.",
              "active": true,
              "order": 5,
              "price": {
                "amountMinor": 900,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": []
            },
            {
              "id": "lunch-vegan",
              "name": "Veganes Lunch-Buffet",
              "description": "Pflanzliche warme und kalte Komponenten.",
              "active": true,
              "order": 6,
              "price": {
                "amountMinor": 2400,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": []
            },
            {
              "id": "lunch-classic",
              "name": "Klassisches Lunch-Buffet",
              "description": "Gemischtes Lunch-Angebot einschließlich vegetarischer Auswahl.",
              "active": true,
              "order": 7,
              "price": {
                "amountMinor": 2700,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": []
            },
            {
              "id": "afternoon-snack",
              "name": "Nachmittagssnack",
              "description": "Kleine herzhafte und süße Snacks.",
              "active": true,
              "order": 8,
              "price": {
                "amountMinor": 700,
                "currency": "EUR"
              },
              "siteIds": [
                "11000000-0000-4000-8000-000000000001"
              ],
              "roomIds": []
            }
          ]
        },
      },
      costCenters: [
        {
          "id": "cc-1000",
          "code": "1000",
          "name": "Geschäftsleitung",
          "active": true
        },
        {
          "id": "cc-2100",
          "code": "2100",
          "name": "Vertrieb",
          "active": true
        },
        {
          "id": "cc-3100",
          "code": "3100",
          "name": "Produktentwicklung",
          "active": true
        },
        {
          "id": "cc-4100",
          "code": "4100",
          "name": "Personal",
          "active": true
        },
        {
          "id": "cc-5100",
          "code": "5100",
          "name": "IT",
          "active": true
        },
        {
          "id": "cc-6100",
          "code": "6100",
          "name": "Marketing",
          "active": true
        }
      ],
      requests: [
          {
            "id": "12000000-0000-4000-8000-000000000001",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-1",
            "status": "Confirmed",
            "startsAt": "2026-06-16T07:00:00.000Z",
            "endsAt": "2026-06-16T09:00:00.000Z",
            "internalParticipants": 16,
            "externalParticipants": 2,
            "title": "Strategieabstimmung",
            "equipmentIds": ["display-86","video-system"],
            "cateringPackageId": "coffee-break",
            "costCenterId": "cc-1000",
            "description": "Strategieabstimmung mit vorbereitetem Raum, passender Präsentationstechnik und " +
              "abgestimmtem Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000002",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-2",
            "status": "Confirmed",
            "startsAt": "2026-06-17T07:00:00.000Z",
            "endsAt": "2026-06-17T09:00:00.000Z",
            "internalParticipants": 8,
            "externalParticipants": 2,
            "title": "Vertriebsplanung",
            "equipmentIds": ["display-65","video-system"],
            "cateringPackageId": "business-breakfast",
            "costCenterId": "cc-2100",
            "description": "Vertriebsplanung mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000003",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-3",
            "status": "Confirmed",
            "startsAt": "2026-06-18T07:00:00.000Z",
            "endsAt": "2026-06-18T09:00:00.000Z",
            "internalParticipants": 14,
            "externalParticipants": 2,
            "title": "Produkt-Workshop",
            "equipmentIds": ["mobile-display","whiteboard"],
            "cateringPackageId": "workshop-day",
            "costCenterId": "cc-3100",
            "description": "Produkt-Workshop mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000004",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-4",
            "status": "Confirmed",
            "startsAt": "2026-06-19T07:00:00.000Z",
            "endsAt": "2026-06-19T09:00:00.000Z",
            "internalParticipants": 10,
            "externalParticipants": 2,
            "title": "Design-Sprint",
            "equipmentIds": ["mobile-display","whiteboard"],
            "cateringPackageId": "vegan-day",
            "costCenterId": "cc-4100",
            "description": "Design-Sprint mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000005",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-5",
            "status": "Confirmed",
            "startsAt": "2026-06-20T07:00:00.000Z",
            "endsAt": "2026-06-20T09:00:00.000Z",
            "internalParticipants": 3,
            "externalParticipants": 0,
            "title": "Projektabstimmung",
            "equipmentIds": ["display-55","usb-camera"],
            "cateringPackageId": "coffee-break",
            "costCenterId": "cc-5100",
            "description": "Projektabstimmung mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000006",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-6",
            "status": "Confirmed",
            "startsAt": "2026-06-16T07:00:00.000Z",
            "endsAt": "2026-06-16T09:00:00.000Z",
            "internalParticipants": 4,
            "externalParticipants": 0,
            "title": "Bewerbungsgespräch",
            "equipmentIds": ["display-55","usb-camera"],
            "cateringPackageId": "business-breakfast",
            "costCenterId": "cc-6100",
            "description": "Bewerbungsgespräch mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000007",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-7",
            "status": "Confirmed",
            "startsAt": "2026-06-17T07:00:00.000Z",
            "endsAt": "2026-06-17T09:00:00.000Z",
            "internalParticipants": 26,
            "externalParticipants": 2,
            "title": "Onboarding-Training",
            "equipmentIds": ["projector","projection-screen"],
            "cateringPackageId": "workshop-day",
            "costCenterId": "cc-1000",
            "description": "Onboarding-Training mit vorbereitetem Raum, passender Präsentationstechnik und " +
              "abgestimmtem Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000008",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-8",
            "status": "Confirmed",
            "startsAt": "2026-06-18T07:00:00.000Z",
            "endsAt": "2026-06-18T09:00:00.000Z",
            "internalParticipants": 4,
            "externalParticipants": 2,
            "title": "Kundengespräch",
            "equipmentIds": ["display-65","video-system"],
            "cateringPackageId": "vegan-day",
            "costCenterId": "cc-2100",
            "description": "Kundengespräch mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000009",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-9",
            "status": "Confirmed",
            "startsAt": "2026-06-19T07:00:00.000Z",
            "endsAt": "2026-06-19T09:00:00.000Z",
            "internalParticipants": 58,
            "externalParticipants": 2,
            "title": "Townhall",
            "equipmentIds": ["projector","projection-screen"],
            "cateringPackageId": "coffee-break",
            "costCenterId": "cc-3100",
            "description": "Townhall mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem Catering. " +
              "Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000010",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-10",
            "status": "Confirmed",
            "startsAt": "2026-06-20T07:00:00.000Z",
            "endsAt": "2026-06-20T09:00:00.000Z",
            "internalParticipants": 6,
            "externalParticipants": 2,
            "title": "Hybrider Kundenworkshop",
            "equipmentIds": ["display-86","video-system"],
            "cateringPackageId": "business-breakfast",
            "costCenterId": "cc-4100",
            "description": "Hybrider Kundenworkshop mit vorbereitetem Raum, passender Präsentationstechnik und " +
              "abgestimmtem Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000011",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-1",
            "status": "Confirmed",
            "startsAt": "2026-06-23T11:00:00.000Z",
            "endsAt": "2026-06-23T13:00:00.000Z",
            "internalParticipants": 16,
            "externalParticipants": 2,
            "title": "Portfolio-Review",
            "equipmentIds": ["display-86","video-system"],
            "cateringPackageId": "workshop-day",
            "costCenterId": "cc-5100",
            "description": "Portfolio-Review mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000012",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-2",
            "status": "Confirmed",
            "startsAt": "2026-06-24T11:00:00.000Z",
            "endsAt": "2026-06-24T13:00:00.000Z",
            "internalParticipants": 8,
            "externalParticipants": 2,
            "title": "Angebotsabstimmung",
            "equipmentIds": ["display-65","video-system"],
            "cateringPackageId": "vegan-day",
            "costCenterId": "cc-6100",
            "description": "Angebotsabstimmung mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000013",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-3",
            "status": "Confirmed",
            "startsAt": "2026-06-25T11:00:00.000Z",
            "endsAt": "2026-06-25T13:00:00.000Z",
            "internalParticipants": 14,
            "externalParticipants": 2,
            "title": "Retrospektive",
            "equipmentIds": ["mobile-display","whiteboard"],
            "cateringPackageId": "coffee-break",
            "costCenterId": "cc-1000",
            "description": "Retrospektive mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000014",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-4",
            "status": "Confirmed",
            "startsAt": "2026-06-26T11:00:00.000Z",
            "endsAt": "2026-06-26T13:00:00.000Z",
            "internalParticipants": 10,
            "externalParticipants": 2,
            "title": "Innovationsworkshop",
            "equipmentIds": ["mobile-display","whiteboard"],
            "cateringPackageId": "business-breakfast",
            "costCenterId": "cc-2100",
            "description": "Innovationsworkshop mit vorbereitetem Raum, passender Präsentationstechnik und " +
              "abgestimmtem Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000015",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-5",
            "status": "Confirmed",
            "startsAt": "2026-06-27T11:00:00.000Z",
            "endsAt": "2026-06-27T13:00:00.000Z",
            "internalParticipants": 3,
            "externalParticipants": 0,
            "title": "Teamabstimmung",
            "equipmentIds": ["display-55","usb-camera"],
            "cateringPackageId": "workshop-day",
            "costCenterId": "cc-3100",
            "description": "Teamabstimmung mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000016",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-6",
            "status": "Confirmed",
            "startsAt": "2026-06-23T11:00:00.000Z",
            "endsAt": "2026-06-23T13:00:00.000Z",
            "internalParticipants": 4,
            "externalParticipants": 0,
            "title": "Interviewrunde",
            "equipmentIds": ["display-55","usb-camera"],
            "cateringPackageId": "vegan-day",
            "costCenterId": "cc-4100",
            "description": "Interviewrunde mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000017",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-7",
            "status": "In Review",
            "startsAt": "2026-06-24T11:00:00.000Z",
            "endsAt": "2026-06-24T13:00:00.000Z",
            "internalParticipants": 26,
            "externalParticipants": 2,
            "title": "Methodentraining",
            "equipmentIds": ["projector","projection-screen"],
            "cateringPackageId": "coffee-break",
            "costCenterId": "cc-5100",
            "description": "Methodentraining mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000018",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-8",
            "status": "In Review",
            "startsAt": "2026-06-25T11:00:00.000Z",
            "endsAt": "2026-06-25T13:00:00.000Z",
            "internalParticipants": 4,
            "externalParticipants": 2,
            "title": "Partnergespräch",
            "equipmentIds": ["display-65","video-system"],
            "cateringPackageId": "business-breakfast",
            "costCenterId": "cc-6100",
            "description": "Partnergespräch mit vorbereitetem Raum, passender Präsentationstechnik und abgestimmtem " +
              "Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000019",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-9",
            "status": "In Review",
            "startsAt": "2026-06-26T11:00:00.000Z",
            "endsAt": "2026-06-26T13:00:00.000Z",
            "internalParticipants": 58,
            "externalParticipants": 2,
            "title": "Informationsveranstaltung",
            "equipmentIds": ["projector","projection-screen"],
            "cateringPackageId": "workshop-day",
            "costCenterId": "cc-1000",
            "description": "Informationsveranstaltung mit vorbereitetem Raum, passender Präsentationstechnik und " +
              "abgestimmtem Catering. Alle Angaben sind synthetische Demodaten."
          },
          {
            "id": "12000000-0000-4000-8000-000000000020",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-10",
            "status": "In Review",
            "startsAt": "2026-06-27T11:00:00.000Z",
            "endsAt": "2026-06-27T13:00:00.000Z",
            "internalParticipants": 6,
            "externalParticipants": 2,
            "title": "Hybride Produktpräsentation",
            "equipmentIds": ["display-86","video-system"],
            "cateringPackageId": "vegan-day",
            "costCenterId": "cc-2100",
            "description": "Hybride Produktpräsentation mit vorbereitetem Raum, passender Präsentationstechnik und " +
              "abgestimmtem Catering. Alle Angaben sind synthetische Demodaten."
          }
        ],
      roomMedia: [
        {
          "id": "51000000-0000-4000-8000-000000000001",
          "roomId": "northwind-berlin-room-1",
          "sha256": "0e97d1b75e31955893dc8460a40b49190e9c9b91e3c53fead0fb7993afcde387",
          "byteLength": 225950,
          "width": 1672,
          "height": 941
        },
        {
          "id": "51000000-0000-4000-8000-000000000002",
          "roomId": "northwind-berlin-room-2",
          "sha256": "24c659f53e141243a090be3128e8a45b2a04f166e123f677e2ac5ba3ee56fbd0",
          "byteLength": 238496,
          "width": 1672,
          "height": 941
        },
        {
          "id": "51000000-0000-4000-8000-000000000003",
          "roomId": "northwind-berlin-room-3",
          "sha256": "c1c9ade4b2162c3c7a147ea10fa7f92e5cb1279041f5d50b82048cd4fb9cb589",
          "byteLength": 230970,
          "width": 1672,
          "height": 941
        },
        {
          "id": "51000000-0000-4000-8000-000000000004",
          "roomId": "northwind-berlin-room-4",
          "sha256": "5830a01f60e1609c085364b9cc7d60be59e35ea512aaba65e970cfa775a67af2",
          "byteLength": 202872,
          "width": 1672,
          "height": 941
        },
        {
          "id": "51000000-0000-4000-8000-000000000005",
          "roomId": "northwind-berlin-room-5",
          "sha256": "85d837bbc8dcbbc04ecf36e044effaad8e4f06008c05c718457ccb5446271ea6",
          "byteLength": 192812,
          "width": 1672,
          "height": 941
        },
        {
          "id": "51000000-0000-4000-8000-000000000006",
          "roomId": "northwind-berlin-room-6",
          "sha256": "d2fa0db2d251f1f313a1a4c575388e0df0534fdf74b26500e4c7434b2463a4cc",
          "byteLength": 199094,
          "width": 1672,
          "height": 941
        },
        {
          "id": "51000000-0000-4000-8000-000000000007",
          "roomId": "northwind-berlin-room-7",
          "sha256": "6af2d97d846039a27a96750844f0ecb27e83a3c920a84ce0bcb113d742323750",
          "byteLength": 199832,
          "width": 1672,
          "height": 940
        },
        {
          "id": "51000000-0000-4000-8000-000000000008",
          "roomId": "northwind-berlin-room-8",
          "sha256": "fefd5edb31626b4a5772bb46d670e0066778e3dcdebf401dd925be5b2959de48",
          "byteLength": 176664,
          "width": 1672,
          "height": 941
        },
        {
          "id": "51000000-0000-4000-8000-000000000009",
          "roomId": "northwind-berlin-room-9",
          "sha256": "c2edd44e096f47205ee94940693013648b359f933ab9ac4806ede28ddd71acc1",
          "byteLength": 143546,
          "width": 1672,
          "height": 941
        },
        {
          "id": "51000000-0000-4000-8000-000000000010",
          "roomId": "northwind-berlin-room-10",
          "sha256": "29a82bf0ab79d189f2a1cc576c8f30d868a998d5e01313560cfd8e41db9bb8d2",
          "byteLength": 172110,
          "width": 1672,
          "height": 941
        }
      ],
      providerSimulation: {
        provider: 'demo_microsoft365',
        identityBindingId: '14000000-0000-4000-8000-000000000001',
        integrationId: '15000000-0000-4000-8000-000000000001',
        providerTenantReference: TENANT_A,
        connectionState: 'connected',
        placesPermission: 'granted',
        calendarsPermission: 'granted',
        health: 'degraded',
        scenario: 'provider_degraded',
        roomMappings: [
            {
              "roomId": "northwind-berlin-room-1",
              "externalRoomId": "northwind-berlin-room-1",
              "resourceAddress": "northwind-berlin-room-1@example.invalid"
            },
            {
              "roomId": "northwind-berlin-room-2",
              "externalRoomId": "northwind-berlin-room-2",
              "resourceAddress": "northwind-berlin-room-2@example.invalid"
            },
            {
              "roomId": "northwind-berlin-room-3",
              "externalRoomId": "northwind-berlin-room-3",
              "resourceAddress": "northwind-berlin-room-3@example.invalid"
            },
            {
              "roomId": "northwind-berlin-room-4",
              "externalRoomId": "northwind-berlin-room-4",
              "resourceAddress": "northwind-berlin-room-4@example.invalid"
            },
            {
              "roomId": "northwind-berlin-room-5",
              "externalRoomId": "northwind-berlin-room-5",
              "resourceAddress": "northwind-berlin-room-5@example.invalid"
            },
            {
              "roomId": "northwind-berlin-room-6",
              "externalRoomId": "northwind-berlin-room-6",
              "resourceAddress": "northwind-berlin-room-6@example.invalid"
            },
            {
              "roomId": "northwind-berlin-room-7",
              "externalRoomId": "northwind-berlin-room-7",
              "resourceAddress": "northwind-berlin-room-7@example.invalid"
            },
            {
              "roomId": "northwind-berlin-room-8",
              "externalRoomId": "northwind-berlin-room-8",
              "resourceAddress": "northwind-berlin-room-8@example.invalid"
            },
            {
              "roomId": "northwind-berlin-room-9",
              "externalRoomId": "northwind-berlin-room-9",
              "resourceAddress": "northwind-berlin-room-9@example.invalid"
            },
            {
              "roomId": "northwind-berlin-room-10",
              "externalRoomId": "northwind-berlin-room-10",
              "resourceAddress": "northwind-berlin-room-10@example.invalid"
            }
          ],
      },
    },
    {
      id: TENANT_B,
      displayName: 'Contoso Demo',
      lifecycleStatus: 'ready',
      lifecycleRevision: 1,
      settings: {
        organization: { name: 'Contoso Demo SAS', countryCode: 'FR' },
        locations: [{
          id: '21000000-0000-4000-8000-000000000002',
          name: 'Paris Demo Campus',
          timeZone: 'Europe/Paris',
          guestInformation: guestInformation('Paris', 'FR'),
          rooms: [
            {
              "id": "contoso-paris-room-1",
              "description": "Kleiner Besprechungsraum mit Präsentationsdisplay.",
              "name": "Paris Atelier",
              "capacity": 16,
              "priceMinor": 9500,
              "floor": null,
              "equipment": [],
              "accessibility": []
            },
            {
              "id": "contoso-paris-room-2",
              "description": null,
              "name": "Paris Studio",
              "capacity": 6,
              "priceMinor": null,
              "floor": null,
              "equipment": [],
              "accessibility": []
            }
          ],
        }],
        catalogue: {
          services: ['room'],
          currency: 'EUR',
          equipment: [{
            id: 'mobile-display', name: 'Contoso mobile display',
            description: null, active: true, order: 1,
            price: { amountMinor: 1800, currency: 'EUR' },
            siteIds: ['21000000-0000-4000-8000-000000000002'],
            roomIds: ['contoso-paris-room-1'],
          }, {
            id: 'contoso-projector', name: 'Contoso projector',
            description: null, active: true, order: 2,
            price: { amountMinor: 3200, currency: 'EUR' }, siteIds: [], roomIds: [],
          }],
          cateringPackages: [], cateringItems: []
        },
      },
      costCenters: [{"id":"cc-100","code":"100","name":"Allgemein","active":true}],
      requests: [
          {
            "id": "22000000-0000-4000-8000-000000000002",
            "requesterUserId": "23000000-0000-4000-8000-000000000002",
            "roomId": "contoso-paris-room-1",
            "status": "In Review",
            "startsAt": "2026-06-17T08:00:00.000Z",
            "endsAt": "2026-06-17T09:30:00.000Z",
            "internalParticipants": 5,
            "externalParticipants": 0,
            "title": "Teamworkshop prüfen",
            "equipmentIds": [],
            "cateringPackageId": null,
            "costCenterId": null,
            "description": null
          },
          {
            "id": "22000000-0000-4000-8000-000000000003",
            "requesterUserId": "23000000-0000-4000-8000-000000000002",
            "roomId": "contoso-paris-room-1",
            "status": "In Review",
            "startsAt": "2026-06-18T08:00:00.000Z",
            "endsAt": "2026-06-18T09:30:00.000Z",
            "internalParticipants": 5,
            "externalParticipants": 0,
            "title": "Kundentermin prüfen",
            "equipmentIds": [],
            "cateringPackageId": null,
            "costCenterId": null,
            "description": null
          },
          {
            "id": "22000000-0000-4000-8000-000000000004",
            "requesterUserId": "23000000-0000-4000-8000-000000000002",
            "roomId": "contoso-paris-room-1",
            "status": "In Review",
            "startsAt": "2026-06-19T08:00:00.000Z",
            "endsAt": "2026-06-19T09:30:00.000Z",
            "internalParticipants": 5,
            "externalParticipants": 0,
            "title": "Projektbesprechung prüfen",
            "equipmentIds": [],
            "cateringPackageId": null,
            "costCenterId": null,
            "description": null
          }
        ],
      roomMedia: [
        {
          "id": "51000000-0000-4000-8000-000000000021",
          "roomId": "contoso-paris-room-1",
          "sha256": "2014af4e798fd951b964b3e4ff923d3e014817ea94db167fbe26f06d2c438d5a",
          "byteLength": 188352,
          "width": 1672,
          "height": 941
        }
      ],
      providerSimulation: {
        provider: 'demo_microsoft365',
        identityBindingId: '24000000-0000-4000-8000-000000000002',
        integrationId: '25000000-0000-4000-8000-000000000002',
        providerTenantReference: TENANT_B,
        connectionState: 'connected',
        placesPermission: 'granted',
        calendarsPermission: 'granted',
        health: 'healthy',
        scenario: 'booking_success',
        roomMappings: [
            {
              "roomId": "contoso-paris-room-1",
              "externalRoomId": "contoso-paris-room-1",
              "resourceAddress": "contoso-paris-room-1@example.invalid"
            },
            {
              "roomId": "contoso-paris-room-2",
              "externalRoomId": "contoso-paris-room-2",
              "resourceAddress": "contoso-paris-room-2@example.invalid"
            }
          ],
      },
    },
    {
      id: TENANT_C,
      displayName: 'Fabrikam Demo',
      lifecycleStatus: 'onboarding',
      lifecycleRevision: 1,
      settings: {
        organization: { name: null, countryCode: 'DE' },
        locations: [],
        catalogue: { services: [], currency: 'EUR', equipment: [], cateringPackages: [], cateringItems: [] },
      },
      costCenters: [],
      requests: [],
      roomMedia: [],
      providerSimulation: {
        provider: 'demo_microsoft365',
        identityBindingId: '44000000-0000-4000-8000-000000000004',
        integrationId: '45000000-0000-4000-8000-000000000004',
        providerTenantReference: TENANT_C,
        connectionState: 'pending',
        placesPermission: 'missing',
        calendarsPermission: 'missing',
        health: 'unknown',
        scenario: 'onboarding',
        roomMappings: [],
      },
    },
  ],
  customerPersonas: [
    customerPersona({
      tenantId: TENANT_A,
      persona: 'employee',
      userId: '13000000-0000-4000-8000-000000000001',
      roles: [TENANT_ROLE.EMPLOYEE],
      providerSubject: 'northwind-employee',
    }),
    customerPersona({
      tenantId: TENANT_A,
      persona: 'conference_manager',
      userId: '13000000-0000-4000-8000-000000000002',
      roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.CONFERENCE_MANAGER],
      providerSubject: 'northwind-conference-manager',
    }),
    customerPersona({
      tenantId: TENANT_A,
      persona: 'tenant_admin',
      userId: '13000000-0000-4000-8000-000000000003',
      roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.TENANT_ADMIN],
      providerSubject: 'northwind-tenant-admin',
    }),
    customerPersona({
      tenantId: TENANT_B,
      persona: 'employee',
      userId: '23000000-0000-4000-8000-000000000002',
      roles: [TENANT_ROLE.EMPLOYEE],
      providerSubject: 'contoso-employee',
    }),
    customerPersona({
      tenantId: TENANT_B,
      persona: 'conference_manager',
      userId: '23000000-0000-4000-8000-000000000003',
      roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.CONFERENCE_MANAGER],
      providerSubject: 'contoso-conference-manager',
    }),
    customerPersona({
      tenantId: TENANT_B,
      persona: 'tenant_admin',
      userId: '23000000-0000-4000-8000-000000000004',
      roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.TENANT_ADMIN],
      providerSubject: 'contoso-tenant-admin',
    }),
    customerPersona({
      tenantId: TENANT_C,
      persona: 'tenant_admin',
      userId: '43000000-0000-4000-8000-000000000004',
      roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.TENANT_ADMIN],
      providerSubject: 'fabrikam-tenant-admin',
    }),
  ],
  platform: {
    personas: [
      platformPersona({
        persona: 'support_reader',
        operatorId: '31000000-0000-4000-8000-000000000001',
        roles: [DEMO_PLATFORM_ROLE.SUPPORT_READER],
        tenantIds: [TENANT_A, TENANT_B, TENANT_C],
        providerSubject: 'demo-support-reader',
        assuranceLevel: 'mfa',
      }),
      platformPersona({
        persona: 'tenant_operator',
        operatorId: '31000000-0000-4000-8000-000000000002',
        roles: [DEMO_PLATFORM_ROLE.TENANT_OPERATOR],
        tenantIds: [TENANT_A, TENANT_B, TENANT_C],
        providerSubject: 'demo-tenant-operator',
        assuranceLevel: 'step_up',
      }),
      platformPersona({
        persona: 'security_auditor',
        operatorId: '31000000-0000-4000-8000-000000000003',
        roles: [DEMO_PLATFORM_ROLE.SECURITY_AUDITOR],
        tenantIds: null,
        providerSubject: 'demo-security-auditor',
        assuranceLevel: 'mfa',
      }),
      platformPersona({
        persona: 'security_admin',
        operatorId: '31000000-0000-4000-8000-000000000004',
        roles: [DEMO_PLATFORM_ROLE.SECURITY_ADMIN],
        tenantIds: null,
        providerSubject: 'demo-security-admin',
        assuranceLevel: 'step_up',
      }),
    ],
    deployment: {
      id: '32000000-0000-4000-8000-000000000001',
      environment: 'test',
      deploymentReference: 'shared-demo-eu-v1',
      schemaVersion: 40,
      requiredDependenciesState: 'ready',
      optionalDependenciesState: 'degraded',
    },
    metering: [
      { tenantId: TENANT_A, period: '2026-06', requestCount: 18 },
      { tenantId: TENANT_B, period: '2026-06', requestCount: 7 },
      { tenantId: TENANT_C, period: '2026-06', requestCount: 0 },
    ],
  },
};

function validateCustomerProviderIdentity(value, code) {
  exactKeys(value, ['provider', 'reference'], code);
  string(value.provider, code, { max: 32, pattern: NAME_PATTERN });
  string(value.reference, code, { max: 80, pattern: /^[a-z0-9][a-z0-9-]{1,79}$/ });
}

function validatePlatformProviderIdentity(value, code) {
  exactKeys(value, ['provider', 'tenantReference', 'subjectReference'], code);
  string(value.provider, code, { max: 32, pattern: NAME_PATTERN });
  string(value.tenantReference, code, { max: 80, pattern: /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$/ });
  string(value.subjectReference, code, { max: 80, pattern: /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$/ });
}

function validateTenant(value) {
  exactKeys(value, [
    'id',
    'displayName',
    'lifecycleStatus',
    'lifecycleRevision',
    'settings',
    'costCenters',
    'roomMedia',
    'requests',
    'providerSimulation',
  ], 'DEMO_FIXTURE_TENANT_INVALID');
  string(value.id, 'DEMO_FIXTURE_TENANT_INVALID', { min: 36, max: 36, pattern: UUID_PATTERN });
  string(value.displayName, 'DEMO_FIXTURE_TENANT_INVALID');
  if (!['active', 'ready', 'onboarding'].includes(value.lifecycleStatus)) fail('DEMO_FIXTURE_TENANT_INVALID');
  const onboarding = value.lifecycleStatus === 'onboarding';
  integer(value.lifecycleRevision, 'DEMO_FIXTURE_TENANT_INVALID', 1);
  exactKeys(value.settings, ['organization', 'locations', 'catalogue'], 'DEMO_FIXTURE_SETTINGS_INVALID');
  exactKeys(value.settings.organization, ['name', 'countryCode'], 'DEMO_FIXTURE_SETTINGS_INVALID');
  if (onboarding && value.settings.organization.name === null) {
    // The Tenant Admin must complete organization data after entering the Demo.
  } else {
    string(value.settings.organization.name, 'DEMO_FIXTURE_SETTINGS_INVALID');
  }
  string(value.settings.organization.countryCode, 'DEMO_FIXTURE_SETTINGS_INVALID', {
    min: 2,
    max: 2,
    pattern: /^[A-Z]{2}$/,
  });
  if (!Array.isArray(value.settings.locations) || value.settings.locations.length < (onboarding ? 0 : 1)) {
    fail('DEMO_FIXTURE_SETTINGS_INVALID');
  }
  for (const location of value.settings.locations) {
    exactKeys(location, ['id', 'name', 'timeZone', 'rooms', 'guestInformation'], 'DEMO_FIXTURE_SETTINGS_INVALID');
    string(location.id, 'DEMO_FIXTURE_SETTINGS_INVALID', { max: 128, pattern: ENTITY_ID_PATTERN });
    string(location.name, 'DEMO_FIXTURE_SETTINGS_INVALID');
    if (!['Europe/Berlin', 'Europe/Paris'].includes(location.timeZone)) {
      fail('DEMO_FIXTURE_SETTINGS_INVALID');
    }
    normalizeSiteGuestInformation(location.guestInformation);
    if (!Array.isArray(location.rooms) || location.rooms.length < 1 || location.rooms.length > 20) {
      fail('DEMO_FIXTURE_SETTINGS_INVALID');
    }
    for (const room of location.rooms) {
      exactKeys(room, [
        'id', 'description', 'name', 'capacity', 'priceMinor', 'floor', 'equipment', 'accessibility',
      ], 'DEMO_FIXTURE_SETTINGS_INVALID');
      string(room.id, 'DEMO_FIXTURE_SETTINGS_INVALID', { max: 128, pattern: ENTITY_ID_PATTERN });
      string(room.name, 'DEMO_FIXTURE_SETTINGS_INVALID');
      if (room.description === null) {
        if (value.lifecycleStatus !== 'ready') fail('DEMO_FIXTURE_SETTINGS_INVALID');
      } else {
        string(room.description, 'DEMO_FIXTURE_SETTINGS_INVALID', { max: 1000 });
      }
      integer(room.capacity, 'DEMO_FIXTURE_SETTINGS_INVALID', 1);
      if (room.floor !== null) string(room.floor, 'DEMO_FIXTURE_SETTINGS_INVALID', { max: 80 });
      if (!Array.isArray(room.equipment) || room.equipment.length > 50) fail('DEMO_FIXTURE_SETTINGS_INVALID');
      for (const entry of room.equipment) {
        string(entry, 'DEMO_FIXTURE_SETTINGS_INVALID', { max: 80 });
      }
      unique(room.equipment, 'DEMO_FIXTURE_SETTINGS_INVALID');
      if (!Array.isArray(room.accessibility) || room.accessibility.length > 20) {
        fail('DEMO_FIXTURE_SETTINGS_INVALID');
      }
      for (const entry of room.accessibility) {
        string(entry, 'DEMO_FIXTURE_SETTINGS_INVALID', { max: 80 });
      }
      unique(room.accessibility, 'DEMO_FIXTURE_SETTINGS_INVALID');
      if (room.priceMinor === null) {
        if (value.lifecycleStatus !== 'ready') fail('DEMO_FIXTURE_SETTINGS_INVALID');
      } else {
        integer(room.priceMinor, 'DEMO_FIXTURE_SETTINGS_INVALID');
      }
    }
    unique(location.rooms.map(({ id }) => id), 'DEMO_FIXTURE_SETTINGS_INVALID');
  }
  unique(value.settings.locations.map(({ id }) => id), 'DEMO_FIXTURE_SETTINGS_INVALID');
  unique(
    value.settings.locations.flatMap(({ rooms }) => rooms.map(({ id }) => id)),
    'DEMO_FIXTURE_SETTINGS_INVALID',
  );
  exactKeys(value.settings.catalogue, [
    'services', 'equipment', 'currency', 'cateringPackages', 'cateringItems',
  ], 'DEMO_FIXTURE_SETTINGS_INVALID');
  const equipment = normalizeTenantCatalogue({
    services: [], equipment: value.settings.catalogue.equipment,
    cateringPackages: value.settings.catalogue.cateringPackages,
    cateringItems: value.settings.catalogue.cateringItems, roomPrices: [],
  }).equipment;
  for (const entry of equipment) {
    if (
      entry.siteIds.some((id) => !value.settings.locations.some((site) => site.id === id))
      || entry.roomIds.some((id) => !value.settings.locations.some((site) => site.rooms.some((room) => room.id === id)))
    ) fail('DEMO_FIXTURE_SETTINGS_INVALID');
  }
  for (const entry of [...value.settings.catalogue.equipment,
    ...value.settings.catalogue.cateringPackages, ...value.settings.catalogue.cateringItems]) {
    if (entry.siteIds.some((id) => !value.settings.locations.some((site) => site.id === id))
      || entry.roomIds.some((id) => !value.settings.locations.some((site) => site.rooms.some((room) => room.id === id)))) {
      fail('DEMO_FIXTURE_SETTINGS_INVALID');
    }
  }
  if (!Array.isArray(value.costCenters) || value.costCenters.length > 200) fail('DEMO_FIXTURE_SETTINGS_INVALID');
  for (const center of value.costCenters) {
    exactKeys(center, ['id', 'code', 'name', 'active'], 'DEMO_FIXTURE_SETTINGS_INVALID');
    string(center.id, 'DEMO_FIXTURE_SETTINGS_INVALID', { max: 128, pattern: ENTITY_ID_PATTERN });
    string(center.code, 'DEMO_FIXTURE_SETTINGS_INVALID', { max: 64, pattern: /^[A-Z0-9][A-Z0-9._-]{0,63}$/ });
    string(center.name, 'DEMO_FIXTURE_SETTINGS_INVALID');
    if (center.active !== true && center.active !== false) fail('DEMO_FIXTURE_SETTINGS_INVALID');
  }
  unique(value.costCenters.map(({ id }) => id), 'DEMO_FIXTURE_SETTINGS_INVALID');
  unique(value.costCenters.map(({ code }) => code), 'DEMO_FIXTURE_SETTINGS_INVALID');
  if (!Array.isArray(value.requests) || value.requests.length < (onboarding ? 0 : 1) || value.requests.length > 20) {
    fail('DEMO_FIXTURE_REQUEST_INVALID');
  }
  for (const request of value.requests) {
    exactKeys(request, [
      'id',
      'requesterUserId',
      'roomId',
      'status',
      'startsAt',
      'endsAt',
      'internalParticipants',
      'externalParticipants',
      'title', 'equipmentIds', 'cateringPackageId', 'costCenterId', 'description',
    ], 'DEMO_FIXTURE_REQUEST_INVALID');
    string(request.id, 'DEMO_FIXTURE_REQUEST_INVALID', { min: 36, max: 36, pattern: UUID_PATTERN });
    string(request.requesterUserId, 'DEMO_FIXTURE_REQUEST_INVALID', { min: 36, max: 36, pattern: UUID_PATTERN });
    string(request.roomId, 'DEMO_FIXTURE_REQUEST_INVALID', { max: 128, pattern: ENTITY_ID_PATTERN });
    if (!value.settings.locations.some(({ rooms }) => rooms.some(({ id }) => id === request.roomId))) {
      fail('DEMO_FIXTURE_REQUEST_INVALID');
    }
    if (!['Confirmed', 'In Review'].includes(request.status)) fail('DEMO_FIXTURE_REQUEST_INVALID');
    utcInstant(request.startsAt, 'DEMO_FIXTURE_REQUEST_INVALID');
    utcInstant(request.endsAt, 'DEMO_FIXTURE_REQUEST_INVALID');
    if (Date.parse(request.endsAt) <= Date.parse(request.startsAt)) fail('DEMO_FIXTURE_REQUEST_INVALID');
    integer(request.internalParticipants, 'DEMO_FIXTURE_REQUEST_INVALID');
    integer(request.externalParticipants, 'DEMO_FIXTURE_REQUEST_INVALID');
    string(request.title, 'DEMO_FIXTURE_REQUEST_INVALID');
    if (!Array.isArray(request.equipmentIds)
      || request.equipmentIds.some((id) => !value.settings.catalogue.equipment.some((entry) => entry.id === id))) {
      fail('DEMO_FIXTURE_REQUEST_INVALID');
    }
    if (request.cateringPackageId !== null
      && !value.settings.catalogue.cateringPackages.some((entry) => entry.id === request.cateringPackageId)) {
      fail('DEMO_FIXTURE_REQUEST_INVALID');
    }
    if (request.costCenterId !== null
      && !value.costCenters.some((center) => center.id === request.costCenterId)) {
      fail('DEMO_FIXTURE_REQUEST_INVALID');
    }
    if (request.description !== null) string(request.description, 'DEMO_FIXTURE_REQUEST_INVALID', { max: 2000 });
  }
  if (!Array.isArray(value.roomMedia) || value.roomMedia.length > 20) {
    fail('DEMO_FIXTURE_MEDIA_INVALID');
  }
  for (const media of value.roomMedia) {
    exactKeys(media, ['id', 'roomId', 'sha256', 'byteLength', 'width', 'height'], 'DEMO_FIXTURE_MEDIA_INVALID');
    string(media.id, 'DEMO_FIXTURE_MEDIA_INVALID', { min: 36, max: 36, pattern: UUID_PATTERN });
    string(media.roomId, 'DEMO_FIXTURE_MEDIA_INVALID', { max: 128, pattern: ENTITY_ID_PATTERN });
    string(media.sha256, 'DEMO_FIXTURE_MEDIA_INVALID', { min: 64, max: 64, pattern: CHECKSUM_PATTERN });
    integer(media.byteLength, 'DEMO_FIXTURE_MEDIA_INVALID', 1);
    integer(media.width, 'DEMO_FIXTURE_MEDIA_INVALID', 1);
    integer(media.height, 'DEMO_FIXTURE_MEDIA_INVALID', 1);
    if (media.byteLength > 2_097_152 || media.width * media.height > 4_000_000
      || !value.settings.locations.some(({ rooms }) => rooms.some(({ id }) => id === media.roomId))) {
      fail('DEMO_FIXTURE_MEDIA_INVALID');
    }
  }
  unique(value.roomMedia.map(({ id }) => id), 'DEMO_FIXTURE_MEDIA_INVALID');
  unique(value.roomMedia.map(({ roomId }) => roomId), 'DEMO_FIXTURE_MEDIA_INVALID');
  exactKeys(
    value.providerSimulation,
    [
      'provider',
      'identityBindingId',
      'integrationId',
      'providerTenantReference',
      'connectionState',
      'placesPermission',
      'calendarsPermission',
      'health',
      'scenario',
      'roomMappings',
    ],
    'DEMO_FIXTURE_PROVIDER_INVALID',
  );
  const provider = value.providerSimulation;
  if (onboarding && (value.settings.locations.length !== 0 || value.requests.length !== 0)) {
    fail('DEMO_FIXTURE_TENANT_INVALID');
  }
  string(provider.provider, 'DEMO_FIXTURE_PROVIDER_INVALID', { max: 48, pattern: NAME_PATTERN });
  string(provider.identityBindingId, 'DEMO_FIXTURE_PROVIDER_INVALID', {
    min: 36,
    max: 36,
    pattern: UUID_PATTERN,
  });
  string(provider.integrationId, 'DEMO_FIXTURE_PROVIDER_INVALID', {
    min: 36,
    max: 36,
    pattern: UUID_PATTERN,
  });
  string(provider.providerTenantReference, 'DEMO_FIXTURE_PROVIDER_INVALID', {
    min: 36,
    max: 36,
    pattern: UUID_PATTERN,
  });
  if (onboarding) {
    if (
      provider.providerTenantReference !== value.id
      || provider.connectionState !== 'pending'
      || provider.placesPermission !== 'missing'
      || provider.calendarsPermission !== 'missing'
      || provider.health !== 'unknown'
      || provider.scenario !== 'onboarding'
      || !Array.isArray(provider.roomMappings)
      || provider.roomMappings.length !== 0
    ) fail('DEMO_FIXTURE_PROVIDER_INVALID');
    return;
  }
  if (
    provider.providerTenantReference !== value.id
    || provider.connectionState !== 'connected'
    || provider.placesPermission !== 'granted'
    || provider.calendarsPermission !== 'granted'
    || !['healthy', 'degraded'].includes(provider.health)
    || !['booking_success', 'provider_degraded'].includes(provider.scenario)
    || (provider.health === 'healthy') !== (provider.scenario === 'booking_success')
  ) {
    fail('DEMO_FIXTURE_PROVIDER_INVALID');
  }
  const rooms = value.settings.locations.flatMap(({ rooms: siteRooms }) => siteRooms);
  if (!Array.isArray(provider.roomMappings) || provider.roomMappings.length !== rooms.length) {
    fail('DEMO_FIXTURE_PROVIDER_INVALID');
  }
  for (const mapping of provider.roomMappings) {
    exactKeys(mapping, ['roomId', 'externalRoomId', 'resourceAddress'], 'DEMO_FIXTURE_PROVIDER_INVALID');
    string(mapping.roomId, 'DEMO_FIXTURE_PROVIDER_INVALID', {
      max: 128, pattern: ENTITY_ID_PATTERN,
    });
    string(mapping.externalRoomId, 'DEMO_FIXTURE_PROVIDER_INVALID', { max: 128 });
    string(mapping.resourceAddress, 'DEMO_FIXTURE_PROVIDER_INVALID', {
      max: 320, pattern: RESOURCE_ADDRESS_PATTERN,
    });
    if (!rooms.some(({ id }) => id === mapping.roomId)) fail('DEMO_FIXTURE_PROVIDER_INVALID');
  }
  unique(provider.roomMappings.map(({ roomId }) => roomId), 'DEMO_FIXTURE_PROVIDER_INVALID');
  unique(provider.roomMappings.map(({ externalRoomId }) => externalRoomId), 'DEMO_FIXTURE_PROVIDER_INVALID');
  unique(provider.roomMappings.map(({ resourceAddress }) => resourceAddress), 'DEMO_FIXTURE_PROVIDER_INVALID');
}

function validateCustomerPersona(value, tenantIds) {
  exactKeys(value, [
    'tenantId',
    'persona',
    'userId',
    'securityVersion',
    'roles',
    'permissions',
    'providerIdentity',
  ], 'DEMO_FIXTURE_CUSTOMER_PERSONA_INVALID');
  if (!tenantIds.has(value.tenantId)) fail('DEMO_FIXTURE_CUSTOMER_PERSONA_INVALID');
  string(value.persona, 'DEMO_FIXTURE_CUSTOMER_PERSONA_INVALID', { max: 32, pattern: NAME_PATTERN });
  string(value.userId, 'DEMO_FIXTURE_CUSTOMER_PERSONA_INVALID', { min: 36, max: 36, pattern: UUID_PATTERN });
  integer(value.securityVersion, 'DEMO_FIXTURE_CUSTOMER_PERSONA_INVALID', 1);
  const snapshot = tenantAuthorizationSnapshot(value.roles);
  if (JSON.stringify(snapshot.permissions) !== JSON.stringify(value.permissions)) {
    fail('DEMO_FIXTURE_CUSTOMER_PERMISSION_INVALID');
  }
  validateCustomerProviderIdentity(value.providerIdentity, 'DEMO_FIXTURE_CUSTOMER_PROVIDER_INVALID');
}

function validatePlatformPersona(value, tenantIds) {
  exactKeys(value, [
    'persona',
    'operatorId',
    'securityVersion',
    'roles',
    'tenantIds',
    'targetScope',
    'providerIdentity',
    'assurance',
  ], 'DEMO_FIXTURE_PLATFORM_PERSONA_INVALID');
  string(value.persona, 'DEMO_FIXTURE_PLATFORM_PERSONA_INVALID', { max: 32, pattern: NAME_PATTERN });
  string(value.operatorId, 'DEMO_FIXTURE_PLATFORM_PERSONA_INVALID', {
    min: 36,
    max: 36,
    pattern: UUID_PATTERN,
  });
  integer(value.securityVersion, 'DEMO_FIXTURE_PLATFORM_PERSONA_INVALID', 1);
  if (
    !Array.isArray(value.roles)
    || value.roles.length < 1
    || value.roles.some((role) => !KNOWN_DEMO_PLATFORM_ROLES.has(role))
    || new Set(value.roles).size !== value.roles.length
  ) fail('DEMO_FIXTURE_PLATFORM_ROLE_INVALID');
  if (!Array.isArray(value.tenantIds)) {
    fail('DEMO_FIXTURE_PLATFORM_SCOPE_INVALID');
  }
  if (value.tenantIds.some((tenantId) => !tenantIds.has(tenantId))) {
    fail('DEMO_FIXTURE_PLATFORM_SCOPE_INVALID');
  }
  unique(value.tenantIds, 'DEMO_FIXTURE_PLATFORM_SCOPE_INVALID');
  exactKeys(value.targetScope, ['mode', 'securityVersion'], 'DEMO_FIXTURE_PLATFORM_SCOPE_INVALID');
  if (
    !['all', 'allowlist'].includes(value.targetScope.mode)
    || value.targetScope.securityVersion !== value.securityVersion
    || (value.targetScope.mode === 'all' && value.tenantIds.length !== 0)
    || (value.targetScope.mode === 'allowlist' && value.tenantIds.length < 1)
  ) fail('DEMO_FIXTURE_PLATFORM_SCOPE_INVALID');
  validatePlatformProviderIdentity(value.providerIdentity, 'DEMO_FIXTURE_PLATFORM_PROVIDER_INVALID');
  exactKeys(value.assurance, ['level', 'authenticationContext'], 'DEMO_FIXTURE_ASSURANCE_INVALID');
  if (!['mfa', 'step_up'].includes(value.assurance.level)) fail('DEMO_FIXTURE_ASSURANCE_INVALID');
  string(value.assurance.authenticationContext, 'DEMO_FIXTURE_ASSURANCE_INVALID', { max: 40 });
}

export function validateDemoFixture(value) {
  exactKeys(
    value,
    ['schemaVersion', 'seedVersion', 'fixedClock', 'tenants', 'customerPersonas', 'platform'],
    'DEMO_FIXTURE_INVALID',
  );
  if (value.schemaVersion !== DEMO_RUNTIME_SCHEMA_VERSION || value.seedVersion !== DEMO_SEED_VERSION) {
    fail('DEMO_FIXTURE_VERSION_INVALID');
  }
  utcInstant(value.fixedClock, 'DEMO_FIXTURE_CLOCK_INVALID');
  if (!Array.isArray(value.tenants) || value.tenants.length < 2 || value.tenants.length > 8) {
    fail('DEMO_FIXTURE_TENANTS_INVALID');
  }
  value.tenants.forEach(validateTenant);
  unique(value.tenants.map(({ id }) => id), 'DEMO_FIXTURE_TENANT_DUPLICATE');
  unique(
    value.tenants.map(({ providerSimulation }) => providerSimulation.identityBindingId),
    'DEMO_FIXTURE_PROVIDER_INVALID',
  );
  unique(
    value.tenants.map(({ providerSimulation }) => providerSimulation.integrationId),
    'DEMO_FIXTURE_PROVIDER_INVALID',
  );
  const tenantIds = new Set(value.tenants.map(({ id }) => id));
  if (!Array.isArray(value.customerPersonas) || value.customerPersonas.length < value.tenants.reduce((count, tenant) => (
    count + (tenant.lifecycleStatus === 'onboarding' ? 1 : 3)
  ), 0)) {
    fail('DEMO_FIXTURE_CUSTOMER_PERSONAS_INVALID');
  }
  value.customerPersonas.forEach((persona) => validateCustomerPersona(persona, tenantIds));
  unique(
    value.customerPersonas.map(({ tenantId, persona }) => customerPersonaKey(tenantId, persona)),
    'DEMO_FIXTURE_CUSTOMER_PERSONA_DUPLICATE',
  );
  for (const tenantId of tenantIds) {
    const tenant = value.tenants.find(({ id }) => id === tenantId);
    const required = tenant.lifecycleStatus === 'onboarding'
      ? ['tenant_admin'] : ['employee', 'conference_manager', 'tenant_admin'];
    for (const persona of required) {
      if (!value.customerPersonas.some((entry) => entry.tenantId === tenantId && entry.persona === persona)) {
        fail('DEMO_FIXTURE_CUSTOMER_PERSONA_REQUIRED');
      }
    }
  }
  exactKeys(value.platform, ['personas', 'deployment', 'metering'], 'DEMO_FIXTURE_PLATFORM_INVALID');
  if (!Array.isArray(value.platform.personas) || value.platform.personas.length < 2) {
    fail('DEMO_FIXTURE_PLATFORM_PERSONAS_INVALID');
  }
  value.platform.personas.forEach((persona) => validatePlatformPersona(persona, tenantIds));
  unique(value.platform.personas.map(({ persona }) => persona), 'DEMO_FIXTURE_PLATFORM_PERSONA_DUPLICATE');
  exactKeys(value.platform.deployment, [
    'id',
    'environment',
    'deploymentReference',
    'schemaVersion',
    'requiredDependenciesState',
    'optionalDependenciesState',
  ], 'DEMO_FIXTURE_PLATFORM_INVALID');
  if (!Array.isArray(value.platform.metering) || value.platform.metering.length !== tenantIds.size) {
    fail('DEMO_FIXTURE_PLATFORM_INVALID');
  }
  return value;
}

export function customerPersonaKey(tenantId, persona) {
  return `${tenantId}:${persona}`;
}


const LOCAL_BASELINE_DAY = Date.UTC(2026, 5, 15);
const DAY_MS = 24 * 60 * 60 * 1000;
const BERLIN_SUMMER_OFFSET_MS = 2 * 60 * 60 * 1000;

function localInstant(day, hour, minute, timeZone) {
  const target = day + hour * 60 * 60 * 1000 + minute * 60 * 1000;
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  let result = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(format.formatToParts(new Date(result))
      .filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]));
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    result += target - shown;
  }
  return new Date(result).toISOString();
}

export function createDemoResetGenerationFixture(baseline, now = new Date()) {
  validateDemoFixture(baseline);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail('DEMO_FIXTURE_CLOCK_INVALID');
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntilMonday = ((8 - new Date(today).getUTCDay()) % 7) || 7;
  const monday = today + daysUntilMonday * DAY_MS;
  const generation = structuredClone(baseline);
  generation.fixedClock = localInstant(monday, 9, 0, 'Europe/Berlin');
  for (const tenant of generation.tenants) {
    for (const request of tenant.requests) {
      const baselineLocalStart = Date.parse(request.startsAt) + BERLIN_SUMMER_OFFSET_MS;
      const baselineLocalDay = Math.floor(baselineLocalStart / DAY_MS) * DAY_MS;
      const dayOffset = (baselineLocalDay - LOCAL_BASELINE_DAY) / DAY_MS;
      const minuteOfDay = (baselineLocalStart - baselineLocalDay) / (60 * 1000);
      const location = tenant.settings.locations.find(({ rooms }) => (
        rooms.some(({ id }) => id === request.roomId)
      ));
      const duration = Date.parse(request.endsAt) - Date.parse(request.startsAt);
      request.startsAt = localInstant(
        monday + dayOffset * DAY_MS,
        Math.floor(minuteOfDay / 60),
        minuteOfDay % 60,
        location.timeZone,
      );
      request.endsAt = new Date(Date.parse(request.startsAt) + duration).toISOString();
    }
  }
  validateDemoFixture(generation);
  return generation;
}

validateDemoFixture(fixture);
export const DEMO_FIXTURE = deepFreeze(fixture);
export const DEMO_FIXTURE_CHECKSUM = semanticChecksum(DEMO_FIXTURE);
export const DEMO_TENANTS = deepFreeze(DEMO_FIXTURE.tenants.map(({
  id,
  displayName,
  lifecycleStatus,
  lifecycleRevision,
}) => ({
  id,
  displayName,
  lifecycleStatus,
  lifecycleRevision,
})));
export const DEMO_CUSTOMER_PERSONAS_BY_CONTEXT = deepFreeze(Object.fromEntries(
  DEMO_FIXTURE.customerPersonas.map((persona) => [customerPersonaKey(persona.tenantId, persona.persona), persona]),
));
export const DEMO_PLATFORM_PERSONAS_BY_NAME = deepFreeze(Object.fromEntries(
  DEMO_FIXTURE.platform.personas.map((persona) => [persona.persona, persona]),
));
