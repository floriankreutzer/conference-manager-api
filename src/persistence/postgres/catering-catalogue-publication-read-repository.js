import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeCateringConfiguration } from '../../integrations/catering-configuration.js';
import { readCateringCatalogueAssignmentsWithClient } from './catering-catalogue-assignment-repository.js';
import { withPostgresTransaction } from './transaction.js';

const MODES = ['catalogue','availability','order','update','cancel','status'];
function invalid() { throw new TypeError('CATERING_CATALOGUE_REVIEW_READ_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function count(value,minimum = 0) {
  const number = Number(value); if (!Number.isSafeInteger(number) || number < minimum || number >= Number.MAX_SAFE_INTEGER) invalid();
  return number;
}
function scope(value) { return { tenantId: uuid(value?.tenantId),integrationId: uuid(value?.integrationId) }; }
function review(row) {
  return Object.freeze({ revision: count(row.review_revision,1),sourceRevision: count(row.source_revision,1),
    configurationRevision: count(row.configuration_revision,1),catalogueRevision: count(row.catalogue_revision,1),
    assignmentRevision: count(row.assignment_revision),publicationRevision: count(row.publication_revision),
    decision: row.decision,justification: row.justification,recordedAt: row.recorded_at.toISOString() });
}
export function createPostgresCateringCataloguePublicationReadRepository(pool,{ registry } = {}) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function' || typeof registry?.get !== 'function') {
    throw new TypeError('CATERING_CATALOGUE_REVIEW_READ_PORT_REQUIRED');
  }
  async function header(client,input) {
    const rows = await client.query({ name: 'catering-catalogue-review-context-read',
      text: `SELECT configuration.*,integration.provider,integration.status,tenant.catalog_revision,
        jsonb_array_length(catalogue.snapshot->'cateringItems')+jsonb_array_length(catalogue.snapshot->'cateringPackages') AS entry_count,
        coalesce(source.revision,0) AS source_revision,coalesce(review.review_revision,0) AS review_revision,
        coalesce(publication.publication_revision,0) AS publication_revision,
        coalesce(published.source_revision,0) AS published_source_revision,
        received.provider_id AS source_provider
        FROM catering_integration_configurations configuration JOIN integrations integration
          ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
        JOIN tenants tenant ON tenant.id=configuration.tenant_id
        JOIN tenant_catalogue_revisions catalogue ON catalogue.tenant_id=tenant.id AND catalogue.revision=tenant.catalog_revision
        LEFT JOIN catering_provider_catalogue_heads source
          ON source.tenant_id=integration.tenant_id AND source.integration_id=integration.id
        LEFT JOIN catering_provider_catalogue_revisions received
          ON received.tenant_id=source.tenant_id AND received.integration_id=source.integration_id AND received.revision=source.revision
        LEFT JOIN catering_catalogue_review_heads review
          ON review.tenant_id=integration.tenant_id AND review.integration_id=integration.id
        LEFT JOIN catering_catalogue_publication_heads publication
          ON publication.tenant_id=integration.tenant_id AND publication.integration_id=integration.id
        LEFT JOIN catering_catalogue_reviews published ON published.tenant_id=publication.tenant_id
          AND published.integration_id=publication.integration_id AND published.review_revision=publication.review_revision
        WHERE configuration.tenant_id=$1 AND configuration.integration_id=$2`,values: [input.tenantId,input.integrationId] });
    if (rows.rowCount === 0) return null; if (rows.rowCount !== 1) invalid();
    const row = rows.rows[0];
    if (row.tenant_id !== input.tenantId || row.integration_id !== input.integrationId
      || (count(row.source_revision)>0 && row.source_provider !== row.provider)) invalid();
    const configuration = normalizeCateringConfiguration({ initialOrderMode: row.initial_order_mode,
      capabilities: Object.fromEntries(MODES.map((mode) => [`catering.${mode}`,row[`${mode}_mode`]])) },registry.get(row.provider));
    return { ...input,providerId: configuration.providerId,configurationRevision: count(row.revision,1),
      configuration: { initialOrderMode: configuration.initialOrderMode,capabilities: configuration.capabilities },
      connectionAvailable: ['configured','active'].includes(row.status),sourceRevision: count(row.source_revision),
      reviewRevision: count(row.review_revision),publicationRevision: count(row.publication_revision),
      publishedSourceRevision: count(row.published_source_revision),catalogueRevision: count(row.catalog_revision,1),
      catalogueEmpty: count(row.entry_count) === 0 };
  }
  return Object.freeze({
    async loadContext(value) {
      const input = scope(value); const after = value.afterBinding;
      if (after !== null && (!after || !['item','package'].includes(after.kind)
        || typeof after.entryId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(after.entryId))) invalid();
      return withPostgresTransaction(pool,async (client) => {
        const selected = await header(client,input); if (!selected) return null;
        const assignments = await readCateringCatalogueAssignmentsWithClient(client,input.tenantId,registry);
        if (!assignments || assignments.tenantId !== input.tenantId
          || assignments.currentCatalogueRevision !== selected.catalogueRevision) invalid();
        const page = await client.query({ name: 'catering-catalogue-review-bindings-page',
          text: `SELECT binding FROM catering_catalogue_publication_heads head JOIN catering_catalogue_reviews review
            ON review.tenant_id=head.tenant_id AND review.integration_id=head.integration_id AND review.review_revision=head.review_revision
            CROSS JOIN LATERAL jsonb_array_elements(review.bindings) binding
            WHERE head.tenant_id=$1 AND head.integration_id=$2
              AND ($3::text IS NULL OR (binding->>'kind' COLLATE "C",binding->>'entryId' COLLATE "C")
                >($3::text COLLATE "C",$4::text COLLATE "C"))
            ORDER BY binding->>'kind' COLLATE "C",binding->>'entryId' COLLATE "C" LIMIT 6`,
          values: [input.tenantId,input.integrationId,after?.kind ?? null,after?.entryId ?? null] });
        if (page.rows.length>6) invalid();
        return Object.freeze({ ...selected,assignmentRevision: assignments.revision,
          assignmentReady: (assignments.revision === 0 && selected.catalogueEmpty)
            || (assignments.assignedCatalogueRevision === selected.catalogueRevision && !assignments.stale),
          bindings: Object.freeze(page.rows.map((row) => row.binding)) });
      },{ isolationLevel: 'REPEATABLE READ',readOnly: true });
    },
    async listHistory(value) {
      const input = scope(value); const before = value.beforeRevision === null ? null : count(value.beforeRevision,1);
      return withPostgresTransaction(pool,async (client) => {
        const selected = await header(client,input); if (!selected) return null;
        const page = await client.query({ name: 'catering-catalogue-review-history-page',
          text: `SELECT review_revision,source_revision,configuration_revision,catalogue_revision,assignment_revision,publication_revision,
            command->>'decision' AS decision,command->>'justification' AS justification,recorded_at
            FROM catering_catalogue_reviews WHERE tenant_id=$1 AND integration_id=$2 AND ($3::bigint IS NULL OR review_revision<$3)
            ORDER BY review_revision DESC LIMIT 21`,values: [input.tenantId,input.integrationId,before] });
        if (page.rows.length>21) invalid();
        return Object.freeze({ tenantId: input.tenantId,integrationId: input.integrationId,reviewRevision: selected.reviewRevision,
          revisions: Object.freeze(page.rows.map(review)) });
      },{ isolationLevel: 'REPEATABLE READ',readOnly: true });
    },
  });
}
