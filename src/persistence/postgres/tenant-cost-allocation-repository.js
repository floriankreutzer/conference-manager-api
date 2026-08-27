import { isInternalUuid } from '../../domain/identifiers.js';
import {
  TenantCostAllocationInputError,
  assertTenantCostAllocationTransition,
  normalizeTenantCostAllocation,
} from '../../domain/tenant-cost-allocation.js';
import { withPostgresTransaction } from './transaction.js';

function persistedStateError() {
  const error = new Error('TENANT_COST_ALLOCATION_PERSISTED_STATE_INVALID');
  error.code = 'TENANT_COST_ALLOCATION_PERSISTED_STATE_INVALID';
  return error;
}

function repositoryInputError(code) {
  const error = new Error(code);
  error.name = 'TenantCostAllocationReferenceError';
  error.code = code;
  return error;
}

function requireUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
  return value;
}

function requireDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(code);
  return value;
}

function requireRevision(value) {
  const revision = Number(value);
  if (
    !Number.isSafeInteger(revision)
    || revision < 1
    || revision >= Number.MAX_SAFE_INTEGER
  ) {
    throw persistedStateError();
  }
  return revision;
}

function requireTimestamp(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw persistedStateError();
  }
  return value.toISOString();
}

function normalizePersistedConfiguration(value) {
  try {
    return normalizeTenantCostAllocation(value);
  } catch (error) {
    if (error instanceof TenantCostAllocationInputError) throw persistedStateError();
    throw error;
  }
}

function requireTransition(current, proposed) {
  try {
    return assertTenantCostAllocationTransition(current, proposed);
  } catch (error) {
    if (error instanceof TenantCostAllocationInputError) {
      throw repositoryInputError(error.code);
    }
    throw error;
  }
}

async function loadRevisionWithClient(client, tenantId, { lock = false } = {}) {
  const result = await client.query({
    name: lock
      ? 'tenant-cost-allocation-revision-lock'
      : 'tenant-cost-allocation-revision',
    text: lock
      ? 'SELECT cost_allocation_revision FROM tenants WHERE id = $1 FOR UPDATE'
      : 'SELECT cost_allocation_revision FROM tenants WHERE id = $1',
    values: [tenantId],
  });
  if (!result.rows[0]) throw new Error('TENANT_NOT_FOUND');
  return requireRevision(result.rows[0].cost_allocation_revision);
}

async function loadConfigurationWithClient(client, tenantId, { lock = false } = {}) {
  const configuration = await client.query({
    name: lock
      ? 'tenant-cost-allocation-configuration-lock'
      : 'tenant-cost-allocation-configuration',
    text: [
      'SELECT allocation_required',
      'FROM tenant_cost_allocation_configuration',
      'WHERE tenant_id = $1',
      lock ? 'FOR UPDATE' : '',
    ].filter(Boolean).join(' '),
    values: [tenantId],
  });
  if (!configuration.rows[0]) throw persistedStateError();
  const centers = await client.query({
    name: 'tenant-cost-allocation-centers',
    text: [
      'SELECT id, code, name, group_name, active',
      'FROM tenant_cost_centers',
      'WHERE tenant_id = $1',
      'ORDER BY id',
    ].join(' '),
    values: [tenantId],
  });
  return normalizePersistedConfiguration({
    allocationRequired: configuration.rows[0].allocation_required,
    costCenters: centers.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      group: row.group_name,
      active: row.active,
    })),
  });
}

async function currentWithClient(client, tenantId, knownRevision = null) {
  const revision = knownRevision ?? await loadRevisionWithClient(client, tenantId);
  const configuration = await loadConfigurationWithClient(client, tenantId);
  return Object.freeze({ revision, configuration });
}

async function ensureSnapshotWithClient(client, {
  tenantId,
  revision,
  configuration,
  changedAt,
  actorUserId,
}) {
  const normalized = normalizePersistedConfiguration(configuration);
  const serialized = JSON.stringify(normalized);
  const existing = await client.query({
    name: 'tenant-cost-allocation-history-match',
    text: [
      'SELECT configuration = $3::jsonb AS matches',
      'FROM tenant_cost_allocation_revisions',
      'WHERE tenant_id = $1 AND revision = $2',
    ].join(' '),
    values: [tenantId, revision, serialized],
  });
  if (existing.rows[0]) {
    if (existing.rows[0].matches !== true) {
      throw new Error('TENANT_COST_ALLOCATION_SNAPSHOT_DIVERGED');
    }
    return false;
  }
  await client.query({
    name: 'tenant-cost-allocation-history-insert',
    text: [
      'INSERT INTO tenant_cost_allocation_revisions',
      '(tenant_id, revision, configuration, changed_at, actor_user_id)',
      'VALUES ($1, $2, $3::jsonb, $4, $5)',
    ].join(' '),
    values: [tenantId, revision, serialized, changedAt, actorUserId],
  });
  return true;
}

async function advanceRevisionWithClient(client, {
  tenantId,
  currentRevision,
  nextRevision,
  changedAt,
}) {
  if (nextRevision !== currentRevision + 1) {
    throw new TypeError('TENANT_COST_ALLOCATION_NEXT_REVISION_INVALID');
  }
  const result = await client.query({
    name: 'tenant-cost-allocation-revision-advance',
    text: [
      'UPDATE tenants',
      'SET cost_allocation_revision = $3, updated_at = $4',
      'WHERE id = $1 AND cost_allocation_revision = $2',
      'RETURNING cost_allocation_revision',
    ].join(' '),
    values: [tenantId, currentRevision, nextRevision, changedAt],
  });
  if (result.rowCount !== 1) throw new Error('TENANT_COST_ALLOCATION_REVISION_RACE');
  return requireRevision(result.rows[0].cost_allocation_revision);
}

async function applyConfiguration(client, tenantId, configuration, changedAt) {
  const update = await client.query({
    name: 'tenant-cost-allocation-configuration-update',
    text: [
      'UPDATE tenant_cost_allocation_configuration',
      'SET allocation_required = $2, updated_at = $3',
      'WHERE tenant_id = $1',
    ].join(' '),
    values: [tenantId, configuration.allocationRequired, changedAt],
  });
  if (update.rowCount !== 1) throw persistedStateError();
  for (const center of configuration.costCenters) {
    await client.query({
      name: 'tenant-cost-allocation-center-upsert',
      text: [
        'INSERT INTO tenant_cost_centers',
        '(tenant_id, id, code, name, group_name, active, created_at, updated_at)',
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $7)',
        'ON CONFLICT (tenant_id, id) DO UPDATE SET',
        'code = EXCLUDED.code, name = EXCLUDED.name,',
        'group_name = EXCLUDED.group_name, active = EXCLUDED.active,',
        'updated_at = EXCLUDED.updated_at',
      ].join(' '),
      values: [
        tenantId,
        center.id,
        center.code,
        center.name,
        center.group,
        center.active,
        changedAt,
      ],
    });
  }
}

async function appendAudit(client, auditRepository, auditEvent) {
  const audit = await auditRepository.appendWithClient(client, auditEvent);
  if (!audit) throw new Error('AUDIT_APPEND_FAILED');
}

export function createPostgresTenantCostAllocationRepository(
  pool,
  { auditRepository } = {},
) {
  if (
    !pool
    || typeof pool.query !== 'function'
    || typeof pool.connect !== 'function'
  ) {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async current(tenantId) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return currentWithClient(client, tenantId);
      });
    },

    async update({
      tenantId,
      expectedRevision,
      nextRevision,
      configuration,
      changedAt,
      actorUserId,
      auditEvent,
    }) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      requireUuid(actorUserId, 'ACTOR_USER_ID_INVALID');
      requireDate(changedAt, 'TENANT_COST_ALLOCATION_CHANGED_AT_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        const currentRevision = await loadRevisionWithClient(
          client,
          tenantId,
          { lock: true },
        );
        if (currentRevision !== expectedRevision) {
          return Object.freeze({ status: 'conflict', currentRevision });
        }
        const current = await loadConfigurationWithClient(
          client,
          tenantId,
          { lock: true },
        );
        const proposed = requireTransition(current, configuration);
        await ensureSnapshotWithClient(client, {
          tenantId,
          revision: currentRevision,
          configuration: current,
          changedAt,
          actorUserId,
        });
        await applyConfiguration(client, tenantId, proposed, changedAt);
        await advanceRevisionWithClient(client, {
          tenantId,
          currentRevision,
          nextRevision,
          changedAt,
        });
        await ensureSnapshotWithClient(client, {
          tenantId,
          revision: nextRevision,
          configuration: proposed,
          changedAt,
          actorUserId,
        });
        await appendAudit(client, auditRepository, auditEvent);
        return Object.freeze({
          revision: nextRevision,
          configuration: proposed,
        });
      });
    },

    async history(tenantId, limit) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      const result = await pool.query({
        name: 'tenant-cost-allocation-history-list',
        text: [
          'SELECT revision, changed_at, actor_user_id',
          'FROM tenant_cost_allocation_revisions',
          'WHERE tenant_id = $1',
          'ORDER BY revision DESC',
          'LIMIT $2',
        ].join(' '),
        values: [tenantId, limit],
      });
      return Object.freeze(result.rows.map((row) => Object.freeze({
        revision: requireRevision(row.revision),
        changedAt: requireTimestamp(row.changed_at),
        actorUserId: requireUuid(
          row.actor_user_id,
          'TENANT_COST_ALLOCATION_HISTORY_ACTOR_INVALID',
        ),
      })));
    },

    async revision(tenantId, revision) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      const result = await pool.query({
        name: 'tenant-cost-allocation-history-get',
        text: [
          'SELECT revision, configuration, changed_at, actor_user_id',
          'FROM tenant_cost_allocation_revisions',
          'WHERE tenant_id = $1 AND revision = $2',
        ].join(' '),
        values: [tenantId, revision],
      });
      const row = result.rows[0];
      return row ? Object.freeze({
        revision: requireRevision(row.revision),
        configuration: normalizePersistedConfiguration(row.configuration),
        changedAt: requireTimestamp(row.changed_at),
        actorUserId: requireUuid(
          row.actor_user_id,
          'TENANT_COST_ALLOCATION_HISTORY_ACTOR_INVALID',
        ),
      }) : null;
    },
  });
}
