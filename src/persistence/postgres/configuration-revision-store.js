import {
  requireConfigurationSnapshot,
  requireExpectedRevision,
  requireHistoryLimit,
  requireRevision,
  requireTenantConfigurationChangeKind,
  requireTenantConfigurationDomain,
  TENANT_CONFIGURATION_CHANGE_KIND,
  TenantConfigurationConflictError,
  TenantConfigurationNotFoundError,
} from '../../domain/tenant-configuration/protocol.js';
import { withPostgresTransaction } from './transaction.js';

function requireChangedAt(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('CONFIGURATION_TIMESTAMP_INVALID');
  }
  return value;
}

function dateIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('CONFIGURATION_TIMESTAMP_INVALID');
  return date.toISOString();
}

function publicRevision(row) {
  return Object.freeze({
    domain: row.domain,
    revision: requireRevision(row.revision),
    changeKind: row.change_kind,
    sourceRevision: row.source_revision === null ? null : requireRevision(row.source_revision),
    actorUserId: row.actor_user_id,
    configuration: requireConfigurationSnapshot(row.payload),
    updatedAt: dateIso(row.created_at),
  });
}

async function lockTenant(client, tenantId) {
  const result = await client.query(
    'SELECT id FROM tenants WHERE id = $1 FOR UPDATE',
    [tenantId],
  );
  if (result.rowCount !== 1) throw new TenantConfigurationNotFoundError('TENANT_NOT_FOUND');
}

async function currentRow(client, tenantId, domain) {
  const result = await client.query(
    `SELECT r.domain,r.revision,r.change_kind,r.source_revision,r.actor_user_id,
            r.payload,r.created_at
       FROM tenant_configuration_heads h
       JOIN tenant_configuration_revisions r
         ON r.tenant_id = h.tenant_id
        AND r.domain = h.domain
        AND r.revision = h.revision
      WHERE h.tenant_id = $1 AND h.domain = $2`,
    [tenantId, domain],
  );
  return result.rows[0] || null;
}

async function initializeCurrent(client, { tenantId, domain, initialize }) {
  const existing = await currentRow(client, tenantId, domain);
  if (existing) return existing;
  const configuration = requireConfigurationSnapshot(await initialize(client, tenantId));
  const inserted = await client.query(
    `INSERT INTO tenant_configuration_revisions (
       tenant_id,domain,revision,change_kind,source_revision,actor_user_id,payload,created_at
     ) VALUES ($1,$2,1,'initial',NULL,NULL,$3,clock_timestamp())
     RETURNING domain,revision,change_kind,source_revision,actor_user_id,payload,created_at`,
    [tenantId, domain, configuration],
  );
  await client.query(
    `INSERT INTO tenant_configuration_heads (tenant_id,domain,revision,updated_at)
     VALUES ($1,$2,1,$3)`,
    [tenantId, domain, inserted.rows[0].created_at],
  );
  return inserted.rows[0];
}

function requireRuntime({ pool, auditRepository }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }
}

function requireInitializer(value) {
  if (typeof value !== 'function') throw new TypeError('CONFIGURATION_INITIALIZER_REQUIRED');
  return value;
}

function requireProjection(value) {
  if (typeof value !== 'function') throw new TypeError('CONFIGURATION_PROJECTION_REQUIRED');
  return value;
}

export function createPostgresConfigurationRevisionStore(pool, { auditRepository } = {}) {
  requireRuntime({ pool, auditRepository });

  async function withCurrent({ tenantId, domain, initialize }, work) {
    const normalizedDomain = requireTenantConfigurationDomain(domain);
    const initializer = requireInitializer(initialize);
    return withPostgresTransaction(pool, async (client) => {
      await lockTenant(client, tenantId);
      const current = await initializeCurrent(client, {
        tenantId,
        domain: normalizedDomain,
        initialize: initializer,
      });
      return work(client, publicRevision(current));
    });
  }

  return Object.freeze({
    current(args) {
      return withCurrent(args, async (_client, current) => current);
    },

    listHistory({ tenantId, domain, initialize, limit = 50 }) {
      const boundedLimit = requireHistoryLimit(limit);
      return withCurrent({ tenantId, domain, initialize }, async (client) => {
        const result = await client.query(
          `SELECT domain,revision,change_kind,source_revision,actor_user_id,payload,created_at
             FROM tenant_configuration_revisions
            WHERE tenant_id = $1 AND domain = $2
            ORDER BY revision DESC
            LIMIT $3`,
          [tenantId, requireTenantConfigurationDomain(domain), boundedLimit],
        );
        return Object.freeze(result.rows.map(publicRevision));
      });
    },

    revision({ tenantId, domain, initialize, revision }) {
      const normalizedRevision = requireRevision(revision);
      return withCurrent({ tenantId, domain, initialize }, async (client) => {
        const result = await client.query(
          `SELECT domain,revision,change_kind,source_revision,actor_user_id,payload,created_at
             FROM tenant_configuration_revisions
            WHERE tenant_id = $1 AND domain = $2 AND revision = $3`,
          [tenantId, requireTenantConfigurationDomain(domain), normalizedRevision],
        );
        if (result.rowCount !== 1) throw new TenantConfigurationNotFoundError();
        return publicRevision(result.rows[0]);
      });
    },

    commit({
      tenantId,
      domain,
      initialize,
      expectedRevision,
      configuration,
      changeKind = TENANT_CONFIGURATION_CHANGE_KIND.CHANGE,
      actorUserId,
      changedAt,
      auditEvent,
      applyProjection,
    }) {
      const normalizedExpectedRevision = requireExpectedRevision(expectedRevision);
      const normalizedConfiguration = requireConfigurationSnapshot(configuration);
      const normalizedChangeKind = requireTenantConfigurationChangeKind(changeKind);
      if (normalizedChangeKind === TENANT_CONFIGURATION_CHANGE_KIND.ROLLBACK) {
        throw new TypeError('CONFIGURATION_COMMIT_KIND_INVALID');
      }
      const projection = requireProjection(applyProjection);
      const normalizedChangedAt = requireChangedAt(changedAt);
      return withCurrent({ tenantId, domain, initialize }, async (client, current) => {
        if (current.revision !== normalizedExpectedRevision) {
          throw new TenantConfigurationConflictError(current.revision);
        }
        const nextRevision = requireRevision(current.revision + 1);
        await projection(client, normalizedConfiguration, normalizedChangedAt, tenantId);
        const inserted = await client.query(
          `INSERT INTO tenant_configuration_revisions (
             tenant_id,domain,revision,change_kind,source_revision,actor_user_id,payload,created_at
           ) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7)
           RETURNING domain,revision,change_kind,source_revision,actor_user_id,payload,created_at`,
          [
            tenantId,
            requireTenantConfigurationDomain(domain),
            nextRevision,
            normalizedChangeKind,
            actorUserId,
            normalizedConfiguration,
            normalizedChangedAt,
          ],
        );
        await client.query(
          `UPDATE tenant_configuration_heads
              SET revision = $3, updated_at = $4
            WHERE tenant_id = $1 AND domain = $2`,
          [tenantId, domain, nextRevision, normalizedChangedAt],
        );
        await auditRepository.appendWithClient(client, auditEvent);
        return publicRevision(inserted.rows[0]);
      });
    },

    rollback({
      tenantId,
      domain,
      initialize,
      expectedRevision,
      sourceRevision,
      actorUserId,
      changedAt,
      auditEvent,
      applyProjection,
    }) {
      const normalizedExpectedRevision = requireExpectedRevision(expectedRevision);
      const normalizedSourceRevision = requireRevision(sourceRevision);
      const projection = requireProjection(applyProjection);
      const normalizedChangedAt = requireChangedAt(changedAt);
      return withCurrent({ tenantId, domain, initialize }, async (client, current) => {
        if (current.revision !== normalizedExpectedRevision) {
          throw new TenantConfigurationConflictError(current.revision);
        }
        if (normalizedSourceRevision >= current.revision) {
          throw new TenantConfigurationNotFoundError();
        }
        const source = await client.query(
          `SELECT payload
             FROM tenant_configuration_revisions
            WHERE tenant_id = $1 AND domain = $2 AND revision = $3`,
          [tenantId, requireTenantConfigurationDomain(domain), normalizedSourceRevision],
        );
        if (source.rowCount !== 1) throw new TenantConfigurationNotFoundError();
        const configuration = requireConfigurationSnapshot(source.rows[0].payload);
        const nextRevision = requireRevision(current.revision + 1);
        await projection(client, configuration, normalizedChangedAt, tenantId);
        const inserted = await client.query(
          `INSERT INTO tenant_configuration_revisions (
             tenant_id,domain,revision,change_kind,source_revision,actor_user_id,payload,created_at
           ) VALUES ($1,$2,$3,'rollback',$4,$5,$6,$7)
           RETURNING domain,revision,change_kind,source_revision,actor_user_id,payload,created_at`,
          [
            tenantId,
            domain,
            nextRevision,
            normalizedSourceRevision,
            actorUserId,
            configuration,
            normalizedChangedAt,
          ],
        );
        await client.query(
          `UPDATE tenant_configuration_heads
              SET revision = $3, updated_at = $4
            WHERE tenant_id = $1 AND domain = $2`,
          [tenantId, domain, nextRevision, normalizedChangedAt],
        );
        await auditRepository.appendWithClient(client, auditEvent);
        return publicRevision(inserted.rows[0]);
      });
    },
  });
}
