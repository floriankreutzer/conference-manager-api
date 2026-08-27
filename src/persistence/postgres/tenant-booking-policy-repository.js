import { isInternalUuid } from '../../domain/identifiers.js';
import {
  TenantBookingPolicyInputError,
  assertTenantBookingPolicyTransition,
  normalizeTenantBookingPolicies,
} from '../../domain/tenant-booking-policies.js';
import { withPostgresTransaction } from './transaction.js';

function persistedStateError() {
  const error = new Error('TENANT_BOOKING_POLICY_PERSISTED_STATE_INVALID');
  error.code = 'TENANT_BOOKING_POLICY_PERSISTED_STATE_INVALID';
  return error;
}

function repositoryInputError(code) {
  const error = new Error(code);
  error.name = 'TenantBookingPolicyReferenceError';
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
    return normalizeTenantBookingPolicies(value);
  } catch (error) {
    if (error instanceof TenantBookingPolicyInputError) throw persistedStateError();
    throw error;
  }
}

function requireTransition(current, proposed, changedAt) {
  try {
    return assertTenantBookingPolicyTransition(current, proposed, changedAt);
  } catch (error) {
    if (error instanceof TenantBookingPolicyInputError) {
      throw repositoryInputError(error.code);
    }
    throw error;
  }
}

async function loadRevisionWithClient(client, tenantId, { lock = false } = {}) {
  const result = await client.query({
    name: lock
      ? 'tenant-booking-policies-revision-lock'
      : 'tenant-booking-policies-revision',
    text: lock
      ? 'SELECT booking_policies_revision FROM tenants WHERE id = $1 FOR UPDATE'
      : 'SELECT booking_policies_revision FROM tenants WHERE id = $1',
    values: [tenantId],
  });
  if (!result.rows[0]) throw new Error('TENANT_NOT_FOUND');
  return requireRevision(result.rows[0].booking_policies_revision);
}

async function loadConfigurationWithClient(client, tenantId, { lock = false } = {}) {
  const result = await client.query({
    name: lock
      ? 'tenant-booking-policies-configuration-lock'
      : 'tenant-booking-policies-configuration',
    text: [
      'SELECT configuration',
      'FROM tenant_booking_policy_configuration',
      'WHERE tenant_id = $1',
      lock ? 'FOR UPDATE' : '',
    ].filter(Boolean).join(' '),
    values: [tenantId],
  });
  if (!result.rows[0]) throw persistedStateError();
  return normalizePersistedConfiguration(result.rows[0].configuration);
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
    name: 'tenant-booking-policies-history-match',
    text: [
      'SELECT configuration = $3::jsonb AS matches',
      'FROM tenant_booking_policy_revisions',
      'WHERE tenant_id = $1 AND revision = $2',
    ].join(' '),
    values: [tenantId, revision, serialized],
  });
  if (existing.rows[0]) {
    if (existing.rows[0].matches !== true) {
      throw new Error('TENANT_BOOKING_POLICY_SNAPSHOT_DIVERGED');
    }
    return false;
  }
  await client.query({
    name: 'tenant-booking-policies-history-insert',
    text: [
      'INSERT INTO tenant_booking_policy_revisions',
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
    throw new TypeError('TENANT_BOOKING_POLICY_NEXT_REVISION_INVALID');
  }
  const result = await client.query({
    name: 'tenant-booking-policies-revision-advance',
    text: [
      'UPDATE tenants',
      'SET booking_policies_revision = $3, updated_at = $4',
      'WHERE id = $1 AND booking_policies_revision = $2',
      'RETURNING booking_policies_revision',
    ].join(' '),
    values: [tenantId, currentRevision, nextRevision, changedAt],
  });
  if (result.rowCount !== 1) throw new Error('TENANT_BOOKING_POLICY_REVISION_RACE');
  return requireRevision(result.rows[0].booking_policies_revision);
}

function changedVersions(current, proposed) {
  const currentById = new Map(current.versions.map((entry) => [entry.id, entry]));
  return proposed.versions.filter((entry) => (
    JSON.stringify(currentById.get(entry.id)) !== JSON.stringify(entry)
  ));
}

function references(versions, key) {
  return [...new Set(versions.flatMap((entry) => entry.rules[key]))];
}

async function requireReferences(client, tenantId, current, proposed) {
  const changed = changedVersions(current, proposed);
  const siteIds = references(changed, 'allowedSiteIds');
  const roomIds = references(changed, 'allowedRoomIds');
  const serviceIds = references(changed, 'allowedServiceIds');

  if (siteIds.length > 0) {
    const result = await client.query({
      name: 'tenant-booking-policies-site-references',
      text: [
        'SELECT id FROM sites',
        'WHERE tenant_id = $1 AND active = TRUE AND id = ANY($2::varchar[])',
      ].join(' '),
      values: [tenantId, siteIds],
    });
    const found = new Set(result.rows.map((row) => row.id));
    if (siteIds.some((id) => !found.has(id))) {
      throw repositoryInputError('TENANT_BOOKING_POLICY_SITE_REFERENCE_INVALID');
    }
  }

  if (roomIds.length > 0) {
    const result = await client.query({
      name: 'tenant-booking-policies-room-references',
      text: [
        'SELECT id, site_id FROM rooms',
        'WHERE tenant_id = $1 AND active = TRUE AND id = ANY($2::varchar[])',
      ].join(' '),
      values: [tenantId, roomIds],
    });
    const found = new Map(result.rows.map((row) => [row.id, row.site_id]));
    if (roomIds.some((id) => !found.has(id))) {
      throw repositoryInputError('TENANT_BOOKING_POLICY_ROOM_REFERENCE_INVALID');
    }
    for (const version of changed) {
      const allowedSites = new Set(version.rules.allowedSiteIds);
      if (
        allowedSites.size > 0
        && version.rules.allowedRoomIds.some((id) => !allowedSites.has(found.get(id)))
      ) {
        throw repositoryInputError(
          'TENANT_BOOKING_POLICY_ROOM_SITE_REFERENCE_INVALID',
        );
      }
    }
  }

  if (serviceIds.length > 0) {
    const result = await client.query({
      name: 'tenant-booking-policies-service-references',
      text: [
        'SELECT id FROM services',
        'WHERE tenant_id = $1 AND active = TRUE AND id = ANY($2::varchar[])',
      ].join(' '),
      values: [tenantId, serviceIds],
    });
    const found = new Set(result.rows.map((row) => row.id));
    if (serviceIds.some((id) => !found.has(id))) {
      throw repositoryInputError('TENANT_BOOKING_POLICY_SERVICE_REFERENCE_INVALID');
    }
  }
}

async function appendAudit(client, auditRepository, auditEvent) {
  const audit = await auditRepository.appendWithClient(client, auditEvent);
  if (!audit) throw new Error('AUDIT_APPEND_FAILED');
}

export function createPostgresTenantBookingPolicyRepository(
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
      requireDate(changedAt, 'TENANT_BOOKING_POLICY_CHANGED_AT_INVALID');
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
        const proposed = requireTransition(current, configuration, changedAt);
        await requireReferences(client, tenantId, current, proposed);
        await ensureSnapshotWithClient(client, {
          tenantId,
          revision: currentRevision,
          configuration: current,
          changedAt,
          actorUserId,
        });
        const updated = await client.query({
          name: 'tenant-booking-policies-configuration-update',
          text: [
            'UPDATE tenant_booking_policy_configuration',
            'SET configuration = $2::jsonb, updated_at = $3, actor_user_id = $4',
            'WHERE tenant_id = $1',
          ].join(' '),
          values: [
            tenantId,
            JSON.stringify(proposed),
            changedAt,
            actorUserId,
          ],
        });
        if (updated.rowCount !== 1) throw persistedStateError();
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
        name: 'tenant-booking-policies-history-list',
        text: [
          'SELECT revision, changed_at, actor_user_id',
          'FROM tenant_booking_policy_revisions',
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
          'TENANT_BOOKING_POLICY_HISTORY_ACTOR_INVALID',
        ),
      })));
    },

    async revision(tenantId, revision) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      const result = await pool.query({
        name: 'tenant-booking-policies-history-get',
        text: [
          'SELECT revision, configuration, changed_at, actor_user_id',
          'FROM tenant_booking_policy_revisions',
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
          'TENANT_BOOKING_POLICY_HISTORY_ACTOR_INVALID',
        ),
      }) : null;
    },
  });
}
