import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { seedBookingLoadFixtures } from '../../scripts/support/target-load-fixtures.mjs';
import { RUN, SHA, NOW } from './target-load-environment.js';

export async function targetLoadManifest({ population = 100, runId = RUN, createdAt = new Date(NOW - 1000).toISOString(),
  expiresAt = new Date(NOW + 600_000).toISOString() } = {}) {
  const tenants = Array.from({ length: 10 }, () => randomUUID());
  const fixtures = await seedBookingLoadFixtures({ async query() {} }, tenants, { population });
  const images = tenants.map(() => ({ assetId: randomUUID(), byteLength: 100,
    sha256: createHash('sha256').update('fixture').digest('hex') }));
  fixtures.expectedRooms.forEach((rooms, index) => { rooms[0].mediaAssetIds = [images[index].assetId]; });
  return { schemaVersion: 1, runId, releaseSha: SHA, createdAt, expiresAt,
    origins: Object.fromEntries(['customer', 'platform'].map(surface =>
      [surface, `https://cm-saas38-load-${runId}-${surface}.onrender.com`])), tenants,
    managers: fixtures.managers, employees: fixtures.employees, expectedRooms: fixtures.expectedRooms, images,
    configurations: tenants.map(() => ({ context: randomBytes(32).toString('base64url'),
      revisions: { organization: 1, locations: 1, catalogue: 1, bookingPolicies: 1, costAllocation: 1 } })),
    storageProbe: { tenantId: tenants[0], ...images[0] } };
}
