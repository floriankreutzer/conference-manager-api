import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizationInputError } from '../src/authorization/errors.js';
import {
  applicationCatalogContextMatches,
  createApplicationCatalogCursor,
  createApplicationCatalogContext,
  normalizeApplicationCatalogQuery,
} from '../src/application/catalog-page.js';

const REVISIONS = Object.freeze({
  organization: 2,
  locations: 3,
  catalogue: 4,
  bookingPolicies: 5,
  costAllocation: 6,
});

function query(overrides = {}) {
  return {
    section: 'services', limit: undefined, cursor: undefined, context: undefined, ...overrides,
  };
}

test('drafting catalog cursor binds section, configuration revisions and policy authority', () => {
  const cursor = createApplicationCatalogCursor({
    section: 'services',
    revisions: REVISIONS,
    policyVersionId: 'policy-v2',
    afterId: 'service-b',
  });
  const page = normalizeApplicationCatalogQuery(query({ limit: '7', cursor }));
  assert.deepEqual(page, {
    section: 'services',
    limit: 7,
    afterId: 'service-b',
    expectedRevisions: REVISIONS,
    expectedPolicyVersionId: 'policy-v2',
  });
  assert.equal(applicationCatalogContextMatches({
    configurationRevisions: REVISIONS,
    bookingPolicy: { policyVersionId: 'policy-v2' },
  }, page), true);
  assert.equal(applicationCatalogContextMatches({
    configurationRevisions: { ...REVISIONS, catalogue: 5 },
    bookingPolicy: { policyVersionId: 'policy-v2' },
  }, page), false);
});

test('drafting catalog context binds every section first page to the bootstrap generation', () => {
  assert.deepEqual(normalizeApplicationCatalogQuery({
    section: 'sites', limit: undefined, cursor: undefined, context: undefined,
  }), {
    section: 'sites',
    limit: 10,
    afterId: null,
    expectedRevisions: null,
    expectedPolicyVersionId: null,
  });
  const context = createApplicationCatalogContext({
    revisions: REVISIONS,
    policyVersionId: 'policy-v2',
  });
  assert.deepEqual(normalizeApplicationCatalogQuery({
    section: 'rooms', limit: undefined, cursor: undefined, context,
  }), {
    section: 'rooms',
    limit: 10,
    afterId: null,
    expectedRevisions: REVISIONS,
    expectedPolicyVersionId: 'policy-v2',
  });
});

test('equipment catalog pages require the bootstrap context and retain section-bound cursors', () => {
  const context = createApplicationCatalogContext({
    revisions: REVISIONS,
    policyVersionId: 'policy-v2',
  });
  assert.deepEqual(normalizeApplicationCatalogQuery({
    section: 'equipment', limit: '2', cursor: undefined, context,
  }), {
    section: 'equipment',
    limit: 2,
    afterId: null,
    expectedRevisions: REVISIONS,
    expectedPolicyVersionId: 'policy-v2',
  });

  const cursor = createApplicationCatalogCursor({
    section: 'equipment',
    revisions: REVISIONS,
    policyVersionId: 'policy-v2',
    afterId: 'projector-b',
  });
  assert.deepEqual(normalizeApplicationCatalogQuery({
    section: 'equipment', limit: '2', cursor, context: undefined,
  }), {
    section: 'equipment',
    limit: 2,
    afterId: 'projector-b',
    expectedRevisions: REVISIONS,
    expectedPolicyVersionId: 'policy-v2',
  });
  assert.throws(() => normalizeApplicationCatalogQuery({
    section: 'services', limit: '2', cursor, context: undefined,
  }), AuthorizationInputError);
});

test('drafting catalog query rejects unknown sections, fields, limits and foreign cursors', () => {
  const cursor = createApplicationCatalogCursor({
    section: 'services',
    revisions: REVISIONS,
    policyVersionId: 'policy-v2',
    afterId: 'service-b',
  });
  for (const value of [
    { section: 'unknown', limit: undefined, cursor: undefined, context: undefined },
    { ...query(), tenantId: 'foreign' },
    query({ limit: '0' }),
    query({ limit: '11' }),
    query({ cursor: 'invalid' }),
    { section: 'rooms', limit: undefined, cursor, context: undefined },
    query(),
  ]) {
    assert.throws(() => normalizeApplicationCatalogQuery(value), AuthorizationInputError);
  }
});
