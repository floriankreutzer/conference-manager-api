import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeCateringCatalogueReviewCommand } from '../../domain/catering-catalogue-publication.js';
import { lockCateringCatalogueManager } from './catering-catalogue-manager-session.js';
import { readCurrentCateringConnectionWithClient } from './catering-current-connection.js';
import { createPostgresTenantCatalogueRepository,loadTenantCatalogueWithClient } from './tenant-catalogue-repository.js';
import { createPostgresCateringCatalogueAssignmentRepository,
  readCateringCatalogueAssignmentsWithClient } from './catering-catalogue-assignment-repository.js';
import { withPostgresTransaction } from './transaction.js';

const COLUMNS = `tenant_id,integration_id,command_id,review_revision,publication_revision,catalogue_revision,assignment_revision,
  reviewed_by_user_id,actor_security_version,command,recorded_at`;
const result = (status,fields = {}) => Object.freeze({ status,...fields });
function invalid() { throw new TypeError('CATERING_CATALOGUE_PUBLICATION_PERSISTENCE_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function count(value,minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) invalid(); return value;
}
class PublicationRollback extends Error {
  constructor(kind) { super('CATERING_PUBLICATION_ROLLBACK'); this.result = result('conflict',{ kind }); }
}
function receipt(row) {
  const command = normalizeCateringCatalogueReviewCommand(row.command);
  if (uuid(row.command_id) !== command.commandId) invalid();
  return Object.freeze({ tenantId: uuid(row.tenant_id),integrationId: uuid(row.integration_id),
    actorUserId: uuid(row.reviewed_by_user_id),actorSecurityVersion: count(Number(row.actor_security_version)),command,
    reviewRevision: count(Number(row.review_revision)),publicationRevision: count(Number(row.publication_revision),0),
    catalogueRevision: count(Number(row.catalogue_revision)),assignmentRevision: count(Number(row.assignment_revision),0),
    recordedAt: row.recorded_at.toISOString() });
}
async function head(client,table,column,input) {
  const row = await client.query({ name: `catering-publication-${table}-lock`,
    text: `SELECT ${column} FROM ${table} WHERE tenant_id=$1 AND integration_id=$2 FOR UPDATE`,
    values: [input.tenantId,input.integrationId] });
  if (row.rowCount > 1) invalid(); return row.rowCount === 0 ? 0 : count(Number(row.rows[0][column]));
}
async function advanceReview(client,input,reviewRevision) {
  const moved = input.command.expectedReviewRevision === 0 ? await client.query({ name: 'catering-publication-review-head-insert',
    text: 'INSERT INTO catering_catalogue_review_heads (tenant_id,integration_id,review_revision) VALUES ($1,$2,$3)',
    values: [input.tenantId,input.integrationId,reviewRevision] }) : await client.query({ name: 'catering-publication-review-head-update',
    text: `UPDATE catering_catalogue_review_heads SET review_revision=$3
      WHERE tenant_id=$1 AND integration_id=$2 AND review_revision=$4`,
    values: [input.tenantId,input.integrationId,reviewRevision,input.command.expectedReviewRevision] });
  if (moved.rowCount !== 1) invalid();
}
async function advancePublication(client,input,publicationRevision,reviewRevision) {
  const moved = input.command.expectedPublicationRevision === 0 ? await client.query({ name: 'catering-publication-head-insert',
    text: `INSERT INTO catering_catalogue_publication_heads (tenant_id,integration_id,publication_revision,review_revision)
      VALUES ($1,$2,$3,$4)`,values: [input.tenantId,input.integrationId,publicationRevision,reviewRevision] })
    : await client.query({ name: 'catering-publication-head-update',
      text: `UPDATE catering_catalogue_publication_heads SET publication_revision=$3,review_revision=$4
        WHERE tenant_id=$1 AND integration_id=$2 AND publication_revision=$5`,
      values: [input.tenantId,input.integrationId,publicationRevision,reviewRevision,input.command.expectedPublicationRevision] });
  if (moved.rowCount !== 1) invalid();
}
function reviewEvent(event,input,counters) {
  if (event?.tenantId !== input.tenantId || event.actorUserId !== input.actorUserId || event.correlationId !== input.correlationId
    || event.action !== `catering.catalogue.${input.command.decision}` || event.targetType !== 'integration'
    || event.targetId !== input.integrationId || event.outcome !== 'success' || event.retentionClass !== 'business'
    || JSON.stringify(event.previousState) !== JSON.stringify({ revision: input.command.expectedReviewRevision })
    || JSON.stringify(event.newState) !== JSON.stringify({ revision: counters.reviewRevision })
    || JSON.stringify(event.metadata) !== JSON.stringify({ assignmentRevision: counters.assignmentRevision,
      catalogueRevision: counters.catalogueRevision,decision: input.command.decision,operation: 'catering_catalogue_review',
      publicationRevision: counters.publicationRevision,sourceRevision: input.command.expectedSourceRevision })) {
    throw new TypeError('CATERING_CATALOGUE_PUBLICATION_AUDIT_SCOPE_INVALID');
  }
  return event;
}

// Tenant -> User -> Session locks serialize current state under READ COMMITTED.
// Same-pool nested writes reuse this client; direct reads use the held Tenant lock.
// Expected conflicts after a write throw through the outer rollback boundary.
export function createPostgresCateringCataloguePublicationRepository(pool,{ registry,auditRepository } = {}) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function' || typeof registry?.get !== 'function'
    || typeof auditRepository?.appendWithClient !== 'function') throw new TypeError('CATERING_PUBLICATION_PERSISTENCE_REQUIRED');
  const catalogueRepository = createPostgresTenantCatalogueRepository(pool,{ auditRepository });
  const assignmentRepository = createPostgresCateringCatalogueAssignmentRepository(pool,{ registry,auditRepository });
  return Object.freeze({
    async review(value) {
      const input = { tenantId: uuid(value?.tenantId),integrationId: uuid(value?.integrationId),actorUserId: uuid(value?.actorUserId),
        sessionId: uuid(value?.sessionId),expectedSecurityVersion: count(value?.expectedSecurityVersion),
        correlationId: uuid(value?.correlationId),command: normalizeCateringCatalogueReviewCommand(value?.command) };
      if (!['planFor','catalogueAuditFor','assignmentAuditFor','reviewAuditFor']
        .every((key) => typeof value?.[key] === 'function')) invalid();
      try {
        return await withPostgresTransaction(pool,async (client) => {
          if (!await lockCateringCatalogueManager(client,input)) return result('not_authorized');
          const prior = await client.query({ name: 'catering-publication-command-read',
            text: `SELECT ${COLUMNS} FROM catering_catalogue_reviews WHERE tenant_id=$1 AND command_id=$2`,
            values: [input.tenantId,input.command.commandId] });
          if (prior.rowCount > 1) invalid();
          if (prior.rowCount === 1) {
            if (prior.rows[0].integration_id !== input.integrationId) return result('conflict',{ kind: 'command' });
            const stored = receipt(prior.rows[0]);
            if (stored.tenantId !== input.tenantId || stored.actorUserId !== input.actorUserId
              || stored.actorSecurityVersion !== input.expectedSecurityVersion
              || JSON.stringify(stored.command) !== JSON.stringify(input.command)) return result('conflict',{ kind: 'command' });
            return result('reviewed',{ replayed: true,receipt: stored });
          }
          const connection = await readCurrentCateringConnectionWithClient(client,input.tenantId,input.integrationId,registry);
          if (connection === null) return result('not_found');
          if (connection.revision !== input.command.expectedConfigurationRevision) return result('conflict',{ kind: 'configuration' });
          if (connection.capabilities['catering.catalogue'] === 'unsupported') return result('conflict',{ kind: 'connection' });
          const sourceRevision = await head(client,'catering_provider_catalogue_heads','revision',input);
          if (sourceRevision !== input.command.expectedSourceRevision) return result('conflict',{ kind: 'source' });
          const reviewRevision = await head(client,'catering_catalogue_review_heads','review_revision',input);
          if (reviewRevision !== input.command.expectedReviewRevision) return result('conflict',{ kind: 'review' });
          const publicationRevision = await head(client,'catering_catalogue_publication_heads','publication_revision',input);
          if (publicationRevision !== input.command.expectedPublicationRevision) return result('conflict',{ kind: 'publication' });
          const source = await client.query({ name: 'catering-publication-source-read',
            text: `SELECT provider_id,source FROM catering_provider_catalogue_revisions
              WHERE tenant_id=$1 AND integration_id=$2 AND revision=$3`,values: [input.tenantId,input.integrationId,sourceRevision] });
          if (source.rowCount !== 1 || source.rows[0].provider_id !== connection.providerId) invalid();
          const current = await loadTenantCatalogueWithClient(client,input.tenantId);
          if (!current || current.revision !== input.command.expectedCatalogueRevision) return result('conflict',{ kind: 'catalogue' });
          const assignment = await readCateringCatalogueAssignmentsWithClient(client,input.tenantId,registry);
          if (!assignment || assignment.revision !== input.command.expectedAssignmentRevision
            || (assignment.assignedCatalogueRevision !== current.revision && !(assignment.revision === 0
              && current.catalogue.cateringItems.length === 0 && current.catalogue.cateringPackages.length === 0))) {
            return result('conflict',{ kind: 'assignment' });
          }
          const increment = input.command.decision === 'published' ? 1 : 0;
          const counters = { reviewRevision: count(reviewRevision+1),publicationRevision: count(publicationRevision+increment,0),
            catalogueRevision: count(current.revision+increment),assignmentRevision: count(assignment.revision+increment,0) };
          let bindings = [];
          if (increment === 1) {
            const previous = await client.query({ name: 'catering-publication-prior-bindings-read',
              text: `SELECT review.bindings FROM catering_catalogue_publication_heads head JOIN catering_catalogue_reviews review
                ON review.tenant_id=head.tenant_id AND review.integration_id=head.integration_id
                  AND review.review_revision=head.review_revision
                WHERE head.tenant_id=$1 AND head.integration_id=$2`,values: [input.tenantId,input.integrationId] });
            if (previous.rowCount !== (publicationRevision === 0 ? 0 : 1)) invalid();
            const connections = [...new Set([input.integrationId,...assignment.assignments.map((entry) => entry.integrationId)])]
              .sort().map((integrationId) => ({ tenantId: input.tenantId,integrationId }));
            let plan;
            try { plan = value.planFor({ tenantId: input.tenantId,integrationId: input.integrationId,sourceRevision,
              configurationRevision: connection.revision,catalogueRevision: current.revision,assignmentRevision: assignment.revision,
              publicationRevision,source: source.rows[0].source,catalogue: current.catalogue,assignments: assignment.assignments,
              connections,previousBindings: previous.rows[0]?.bindings ?? [] }); }
            catch (error) {
              const conflicts = { CATERING_CATALOGUE_PUBLICATION_SOURCE_UNKNOWN: 'source',
                CATERING_CATALOGUE_PUBLICATION_OWNER_CONFLICT: 'assignment',
                CATERING_CATALOGUE_PUBLICATION_COMPONENT_UNREVIEWED: 'reference',
                CATERING_CATALOGUE_PUBLICATION_CATALOGUE_CONFLICT: 'catalogue' };
              if (error instanceof TypeError && Object.hasOwn(conflicts,error.message)) {
                return result('conflict',{ kind: conflicts[error.message] });
              }
              throw error;
            }
            if (plan.tenantId !== input.tenantId || plan.integrationId !== input.integrationId || plan.commandId !== input.command.commandId
              || plan.sourceRevision !== sourceRevision || plan.configurationRevision !== connection.revision
              || plan.catalogueRevision !== counters.catalogueRevision || plan.assignmentRevision !== counters.assignmentRevision
              || plan.publicationRevision !== counters.publicationRevision) invalid();
            const changedAt = new Date();
            const catalogue = await catalogueRepository.replace({ tenantId: input.tenantId,actorUserId: input.actorUserId,
              correlationId: input.correlationId,expectedRevision: current.revision,catalogue: plan.catalogue,changedAt,
              auditEventFor: value.catalogueAuditFor });
            if (catalogue.status !== 'updated') {
              throw new PublicationRollback(catalogue.status === 'reference_invalid' ? 'reference' : 'catalogue');
            }
            let assigned;
            try { assigned = await assignmentRepository.replace({ ...input,expectedRevision: assignment.revision,changedAt,
              proposal: { schemaVersion: 1,catalogueRevision: counters.catalogueRevision,assignments: plan.assignments },
              auditEventFor: value.assignmentAuditFor }); }
            catch (error) {
              if (error?.code === 'CATERING_CATALOGUE_CONNECTION_UNKNOWN') throw new PublicationRollback('connection');
              throw error;
            }
            if (assigned.status !== 'updated' || assigned.current.revision !== counters.assignmentRevision
              || assigned.current.stale || assigned.current.currentCatalogueRevision !== counters.catalogueRevision) {
              throw new PublicationRollback('assignment');
            }
            bindings = plan.bindings;
          }
          const stored = await client.query({ name: 'catering-publication-review-insert',
            text: `INSERT INTO catering_catalogue_reviews (tenant_id,integration_id,command_id,review_revision,source_revision,
              configuration_revision,publication_revision,catalogue_revision,assignment_revision,reviewed_by_user_id,
              actor_security_version,correlation_id,command,bindings)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb) RETURNING ${COLUMNS}`,
            values: [input.tenantId,input.integrationId,input.command.commandId,counters.reviewRevision,sourceRevision,
              connection.revision,counters.publicationRevision,counters.catalogueRevision,counters.assignmentRevision,
              input.actorUserId,input.expectedSecurityVersion,input.correlationId,
              JSON.stringify(input.command),JSON.stringify(bindings)] });
          if (stored.rowCount !== 1) invalid();
          await advanceReview(client,input,counters.reviewRevision);
          if (increment === 1) await advancePublication(client,input,counters.publicationRevision,counters.reviewRevision);
          if (!await auditRepository.appendWithClient(client,reviewEvent(value.reviewAuditFor(counters),input,counters))) {
            throw new Error('AUDIT_APPEND_FAILED');
          }
          return result('reviewed',{ replayed: false,receipt: receipt(stored.rows[0]) });
        });
      } catch (error) {
        if (error instanceof PublicationRollback) return error.result;
        throw error;
      }
    },
  });
}
