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
          guestInformation: guestInformation('Berlin', 'DE'),
          rooms: [
            {
              "id": "northwind-berlin-room-1",
              "name": "Berlin Forum",
              "capacity": 24,
              "priceMinor": 12500
            },
            {
              "id": "northwind-berlin-room-2",
              "name": "Spree Boardroom",
              "capacity": 12,
              "priceMinor": 9500
            },
            {
              "id": "northwind-berlin-room-3",
              "name": "Workshop Loft",
              "capacity": 20,
              "priceMinor": 11000
            },
            {
              "id": "northwind-berlin-room-4",
              "name": "Innovation Lab",
              "capacity": 16,
              "priceMinor": 10000
            },
            {
              "id": "northwind-berlin-room-5",
              "name": "Focus One",
              "capacity": 4,
              "priceMinor": 3500
            },
            {
              "id": "northwind-berlin-room-6",
              "name": "Focus Two",
              "capacity": 4,
              "priceMinor": 3500
            },
            {
              "id": "northwind-berlin-room-7",
              "name": "Training Campus",
              "capacity": 36,
              "priceMinor": 16000
            },
            {
              "id": "northwind-berlin-room-8",
              "name": "Executive Lounge",
              "capacity": 8,
              "priceMinor": 9000
            },
            {
              "id": "northwind-berlin-room-9",
              "name": "Townhall Auditorium",
              "capacity": 80,
              "priceMinor": 30000
            },
            {
              "id": "northwind-berlin-room-10",
              "name": "Hybrid Studio",
              "capacity": 10,
              "priceMinor": 12000
            }
          ],
        }],
        catalogue: {
          services: ['room', 'catering'],
          currency: 'EUR',
          equipment: [{
            id: 'mobile-display', name: 'Northwind mobile display',
            description: 'Portable presentation display', active: true, order: 1,
            price: { amountMinor: 2500, currency: 'EUR' },
            siteIds: ['11000000-0000-4000-8000-000000000001'],
            roomIds: ['northwind-berlin-room-1'],
          }],
        },
      },
      requests: [
          {
            "id": "12000000-0000-4000-8000-000000000001",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-1",
            "status": "Confirmed",
            "startsAt": "2026-06-16T07:00:00.000Z",
            "endsAt": "2026-06-16T09:00:00.000Z",
            "internalParticipants": 16,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000002",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-2",
            "status": "Confirmed",
            "startsAt": "2026-06-17T07:00:00.000Z",
            "endsAt": "2026-06-17T09:00:00.000Z",
            "internalParticipants": 8,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000003",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-3",
            "status": "Confirmed",
            "startsAt": "2026-06-18T07:00:00.000Z",
            "endsAt": "2026-06-18T09:00:00.000Z",
            "internalParticipants": 14,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000004",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-4",
            "status": "Confirmed",
            "startsAt": "2026-06-19T07:00:00.000Z",
            "endsAt": "2026-06-19T09:00:00.000Z",
            "internalParticipants": 10,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000005",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-5",
            "status": "Confirmed",
            "startsAt": "2026-06-20T07:00:00.000Z",
            "endsAt": "2026-06-20T09:00:00.000Z",
            "internalParticipants": 3,
            "externalParticipants": 0
          },
          {
            "id": "12000000-0000-4000-8000-000000000006",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-6",
            "status": "Confirmed",
            "startsAt": "2026-06-16T07:00:00.000Z",
            "endsAt": "2026-06-16T09:00:00.000Z",
            "internalParticipants": 4,
            "externalParticipants": 0
          },
          {
            "id": "12000000-0000-4000-8000-000000000007",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-7",
            "status": "Confirmed",
            "startsAt": "2026-06-17T07:00:00.000Z",
            "endsAt": "2026-06-17T09:00:00.000Z",
            "internalParticipants": 26,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000008",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-8",
            "status": "Confirmed",
            "startsAt": "2026-06-18T07:00:00.000Z",
            "endsAt": "2026-06-18T09:00:00.000Z",
            "internalParticipants": 4,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000009",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-9",
            "status": "Confirmed",
            "startsAt": "2026-06-19T07:00:00.000Z",
            "endsAt": "2026-06-19T09:00:00.000Z",
            "internalParticipants": 58,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000010",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-10",
            "status": "Confirmed",
            "startsAt": "2026-06-20T07:00:00.000Z",
            "endsAt": "2026-06-20T09:00:00.000Z",
            "internalParticipants": 6,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000011",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-1",
            "status": "Confirmed",
            "startsAt": "2026-06-23T11:00:00.000Z",
            "endsAt": "2026-06-23T13:00:00.000Z",
            "internalParticipants": 16,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000012",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-2",
            "status": "Confirmed",
            "startsAt": "2026-06-24T11:00:00.000Z",
            "endsAt": "2026-06-24T13:00:00.000Z",
            "internalParticipants": 8,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000013",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-3",
            "status": "Confirmed",
            "startsAt": "2026-06-25T11:00:00.000Z",
            "endsAt": "2026-06-25T13:00:00.000Z",
            "internalParticipants": 14,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000014",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-4",
            "status": "Confirmed",
            "startsAt": "2026-06-26T11:00:00.000Z",
            "endsAt": "2026-06-26T13:00:00.000Z",
            "internalParticipants": 10,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000015",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-5",
            "status": "Confirmed",
            "startsAt": "2026-06-27T11:00:00.000Z",
            "endsAt": "2026-06-27T13:00:00.000Z",
            "internalParticipants": 3,
            "externalParticipants": 0
          },
          {
            "id": "12000000-0000-4000-8000-000000000016",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-6",
            "status": "Confirmed",
            "startsAt": "2026-06-23T11:00:00.000Z",
            "endsAt": "2026-06-23T13:00:00.000Z",
            "internalParticipants": 4,
            "externalParticipants": 0
          },
          {
            "id": "12000000-0000-4000-8000-000000000017",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-7",
            "status": "In Review",
            "startsAt": "2026-06-24T11:00:00.000Z",
            "endsAt": "2026-06-24T13:00:00.000Z",
            "internalParticipants": 26,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000018",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-8",
            "status": "In Review",
            "startsAt": "2026-06-25T11:00:00.000Z",
            "endsAt": "2026-06-25T13:00:00.000Z",
            "internalParticipants": 4,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000019",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-9",
            "status": "In Review",
            "startsAt": "2026-06-26T11:00:00.000Z",
            "endsAt": "2026-06-26T13:00:00.000Z",
            "internalParticipants": 58,
            "externalParticipants": 2
          },
          {
            "id": "12000000-0000-4000-8000-000000000020",
            "requesterUserId": "13000000-0000-4000-8000-000000000001",
            "roomId": "northwind-berlin-room-10",
            "status": "In Review",
            "startsAt": "2026-06-27T11:00:00.000Z",
            "endsAt": "2026-06-27T13:00:00.000Z",
            "internalParticipants": 6,
            "externalParticipants": 2
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
          guestInformation: guestInformation('Paris', 'FR'),
          rooms: [
            {
              "id": "contoso-paris-room-1",
              "name": "Paris Atelier",
              "capacity": 16,
              "priceMinor": 9500
            },
            {
              "id": "contoso-paris-room-2",
              "name": "Paris Studio",
              "capacity": 6,
              "priceMinor": null
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
        },
      },
      requests: [
          {
            "id": "22000000-0000-4000-8000-000000000002",
            "requesterUserId": "23000000-0000-4000-8000-000000000002",
            "roomId": "contoso-paris-room-1",
            "status": "In Review",
            "startsAt": "2026-06-17T08:00:00.000Z",
            "endsAt": "2026-06-17T09:30:00.000Z",
            "internalParticipants": 5,
            "externalParticipants": 0
          },
          {
            "id": "22000000-0000-4000-8000-000000000003",
            "requesterUserId": "23000000-0000-4000-8000-000000000002",
            "roomId": "contoso-paris-room-1",
            "status": "In Review",
            "startsAt": "2026-06-18T08:00:00.000Z",
            "endsAt": "2026-06-18T09:30:00.000Z",
            "internalParticipants": 5,
            "externalParticipants": 0
          },
          {
            "id": "22000000-0000-4000-8000-000000000004",
            "requesterUserId": "23000000-0000-4000-8000-000000000002",
            "roomId": "contoso-paris-room-1",
            "status": "In Review",
            "startsAt": "2026-06-19T08:00:00.000Z",
            "endsAt": "2026-06-19T09:30:00.000Z",
            "internalParticipants": 5,
            "externalParticipants": 0
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
  ],
  platform: {
    personas: [
      platformPersona({
        persona: 'support_reader',
        operatorId: '31000000-0000-4000-8000-000000000001',
        roles: [DEMO_PLATFORM_ROLE.SUPPORT_READER],
        tenantIds: [TENANT_A, TENANT_B],
        providerSubject: 'demo-support-reader',
        assuranceLevel: 'mfa',
      }),
      platformPersona({
        persona: 'tenant_operator',
        operatorId: '31000000-0000-4000-8000-000000000002',
        roles: [DEMO_PLATFORM_ROLE.TENANT_OPERATOR],
        tenantIds: [TENANT_A, TENANT_B],
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
  string(value.settings.organization.name, 'DEMO_FIXTURE_SETTINGS_INVALID', { min: onboarding ? 0 : 1 });
  string(value.settings.organization.countryCode, 'DEMO_FIXTURE_SETTINGS_INVALID', {
    min: 2,
    max: 2,
    pattern: /^[A-Z]{2}$/,
  });
  if (!Array.isArray(value.settings.locations) || value.settings.locations.length < (onboarding ? 0 : 1)) {
    fail('DEMO_FIXTURE_SETTINGS_INVALID');
  }
  for (const location of value.settings.locations) {
    exactKeys(location, ['id', 'name', 'rooms', 'guestInformation'], 'DEMO_FIXTURE_SETTINGS_INVALID');
    string(location.id, 'DEMO_FIXTURE_SETTINGS_INVALID', { max: 128, pattern: ENTITY_ID_PATTERN });
    string(location.name, 'DEMO_FIXTURE_SETTINGS_INVALID');
    normalizeSiteGuestInformation(location.guestInformation);
    if (!Array.isArray(location.rooms) || location.rooms.length < 1 || location.rooms.length > 20) {
      fail('DEMO_FIXTURE_SETTINGS_INVALID');
    }
    for (const room of location.rooms) {
      exactKeys(room, ['id', 'name', 'capacity', 'priceMinor'], 'DEMO_FIXTURE_SETTINGS_INVALID');
      string(room.id, 'DEMO_FIXTURE_SETTINGS_INVALID', { max: 128, pattern: ENTITY_ID_PATTERN });
      string(room.name, 'DEMO_FIXTURE_SETTINGS_INVALID');
      integer(room.capacity, 'DEMO_FIXTURE_SETTINGS_INVALID', 1);
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
  exactKeys(value.settings.catalogue, ['services', 'equipment', 'currency'], 'DEMO_FIXTURE_SETTINGS_INVALID');
  const equipment = normalizeTenantCatalogue({
    services: [], equipment: value.settings.catalogue.equipment,
    cateringPackages: [], cateringItems: [], roomPrices: [],
  }).equipment;
  for (const entry of equipment) {
    if (
      entry.siteIds.some((id) => !value.settings.locations.some((site) => site.id === id))
      || entry.roomIds.some((id) => !value.settings.locations.some((site) => site.rooms.some((room) => room.id === id)))
    ) fail('DEMO_FIXTURE_SETTINGS_INVALID');
  }
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
  }
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
      || provider.connectionState !== 'not_configured'
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
  if (!Array.isArray(value.customerPersonas) || value.customerPersonas.length < value.tenants.length * 3) {
    fail('DEMO_FIXTURE_CUSTOMER_PERSONAS_INVALID');
  }
  value.customerPersonas.forEach((persona) => validateCustomerPersona(persona, tenantIds));
  unique(
    value.customerPersonas.map(({ tenantId, persona }) => customerPersonaKey(tenantId, persona)),
    'DEMO_FIXTURE_CUSTOMER_PERSONA_DUPLICATE',
  );
  for (const tenantId of tenantIds) {
    for (const persona of ['employee', 'conference_manager', 'tenant_admin']) {
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
