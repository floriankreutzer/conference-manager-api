import { withPostgresTransaction } from './transaction.js';
import { normalizeCapabilityId } from '../../entitlements/capabilities.js';

function mapEntitlementRow(row, fallback) {
  if (!row) return fallback || null;
  return Object.freeze({
    tenantId: row.tenant_id,
    capabilityId: row.capability_id,
    enabled: row.enabled,
    updatedAt: row.updated_at.toISOString(),
  });
}

export function createPostgresEntitlementRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  async function findByTenantIdAndCapabilityId(tenantId, capabilityId, { client = pool } = {}) {
      const result = await client.query({
        name: 'entitlement-find-by-tenant-and-capability',
        text: `
          SELECT tenant_id, capability_id, enabled, updated_at
          FROM tenant_entitlements
          WHERE tenant_id = $1
            AND capability_id = $2
          LIMIT 1
        `,
        values: [tenantId, capabilityId],
      });
      return mapEntitlementRow(result.rows[0]);
  }

  async function findTenantState(tenantId, { client = pool, lock = false } = {}) {
    const tenant = await client.query({
      name: lock ? 'entitlement-tenant-state-lock' : 'entitlement-tenant-state',
      text: `
        SELECT id, status, entitlement_revision
        FROM tenants
        WHERE id = $1
        ${lock ? 'FOR UPDATE' : ''}
      `,
      values: [tenantId],
    });
    if (tenant.rowCount !== 1) return null;
    const entries = await client.query({
      name: 'entitlement-tenant-state-entries',
      text: `
        SELECT tenant_id, capability_id, enabled, updated_at
        FROM tenant_entitlements
        WHERE tenant_id = $1
        ORDER BY capability_id ASC
        ${lock ? 'FOR UPDATE' : ''}
      `,
      values: [tenantId],
    });
    return Object.freeze({
      tenantId: tenant.rows[0].id,
      tenantStatus: tenant.rows[0].status,
      revision: Number(tenant.rows[0].entitlement_revision),
      entries: Object.freeze(entries.rows.map((row) => mapEntitlementRow(row))),
    });
  }

  async function applyChangesWithClient(client, {
    tenantId,
    expectedRevision = null,
    expectedStatus = null,
    changes,
    changedAt,
  } = {}) {
    if (!client || typeof client.query !== 'function') throw new TypeError('POSTGRES_CLIENT_REQUIRED');
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 64) {
      throw new TypeError('ENTITLEMENT_CHANGES_INVALID');
    }
    const normalized = changes.map((change) => Object.freeze({
      capabilityId: normalizeCapabilityId(change.capabilityId),
      enabled: typeof change.enabled === 'boolean'
        ? change.enabled
        : (() => { throw new TypeError('ENTITLEMENT_CHANGES_INVALID'); })(),
    }));
    if (new Set(normalized.map((change) => change.capabilityId)).size !== normalized.length) {
      throw new TypeError('ENTITLEMENT_CHANGES_INVALID');
    }
    const state = await findTenantState(tenantId, { client, lock: true });
    if (!state) return Object.freeze({ outcome: 'not_found' });
    if (
      (expectedRevision !== null && state.revision !== expectedRevision)
      || (expectedStatus !== null && state.tenantStatus !== expectedStatus)
    ) return Object.freeze({ outcome: 'stale', state });
    const previous = new Map(state.entries.map((entry) => [entry.capabilityId, entry.enabled]));
    const actualChanges = normalized.filter((change) => (previous.get(change.capabilityId) ?? false) !== change.enabled);
    if (actualChanges.length === 0) return Object.freeze({ outcome: 'unchanged', state });
    const written = await client.query({
      name: 'entitlement-apply-changes-bulk',
      text: `
        INSERT INTO tenant_entitlements (tenant_id, capability_id, enabled, updated_at)
        SELECT $1, change.capability_id, change.enabled, $3
        FROM jsonb_to_recordset($2::jsonb) AS change(capability_id varchar, enabled boolean)
        ON CONFLICT (tenant_id, capability_id)
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at
        RETURNING tenant_id, capability_id, enabled, updated_at
      `,
      values: [
        tenantId,
        JSON.stringify(actualChanges.map((change) => ({
          capability_id: change.capabilityId,
          enabled: change.enabled,
        }))),
        changedAt,
      ],
    });
    if (written.rowCount !== actualChanges.length) throw new Error('ENTITLEMENT_APPLY_INCOMPLETE');
    const advanced = await client.query({
      name: 'entitlement-advance-aggregate-revision',
      text: `
        UPDATE tenants
        SET entitlement_revision = entitlement_revision + 1,
            updated_at = GREATEST(updated_at, $2::timestamptz)
        WHERE id = $1 AND entitlement_revision = $3
        RETURNING id, status, entitlement_revision
      `,
      values: [tenantId, changedAt, state.revision],
    });
    if (advanced.rowCount !== 1) return Object.freeze({ outcome: 'stale', state });
    const entries = await client.query({
      name: 'entitlement-applied-state-entries',
      text: `
        SELECT tenant_id, capability_id, enabled, updated_at
        FROM tenant_entitlements WHERE tenant_id = $1 ORDER BY capability_id ASC
      `,
      values: [tenantId],
    });
    return Object.freeze({
      outcome: 'updated',
      previous: Object.freeze(actualChanges.map((change) => Object.freeze({
        capabilityId: change.capabilityId,
        previousEnabled: previous.get(change.capabilityId) ?? false,
        enabled: change.enabled,
      }))),
      state: Object.freeze({
        tenantId,
        tenantStatus: advanced.rows[0].status,
        revision: Number(advanced.rows[0].entitlement_revision),
        entries: Object.freeze(entries.rows.map((row) => mapEntitlementRow(row))),
      }),
    });
  }

  return Object.freeze({
    findByTenantIdAndCapabilityId,
    findTenantState,
    applyChangesWithClient,

    async changeByTenantIdAndCapabilityId({
      tenantId,
      capabilityId,
      enabled,
      changedAt,
      auditEventForPrevious,
    }) {
      if (typeof auditEventForPrevious !== 'function') throw new TypeError('AUDIT_EVENT_FACTORY_REQUIRED');
      return withPostgresTransaction(pool, async (client) => {
        await client.query({
          text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          values: [`entitlement:${tenantId}:${capabilityId}`],
        });
        const currentState = await findTenantState(tenantId, { client, lock: true });
        if (!currentState) return null;
        const previousEntry = currentState.entries.find((entry) => entry.capabilityId === capabilityId);
        const previousEnabled = previousEntry?.enabled === true;
        if (!previousEntry && enabled === false) {
          return Object.freeze({ tenantId, capabilityId, enabled: false, updatedAt: null });
        }
        if (previousEntry && previousEnabled === enabled) return previousEntry;
        const applied = await applyChangesWithClient(client, {
          tenantId,
          expectedRevision: currentState.revision,
          expectedStatus: currentState.tenantStatus,
          changes: [{ capabilityId, enabled }],
          changedAt,
        });
        if (applied.outcome !== 'updated') throw new Error('ENTITLEMENT_APPLY_FAILED');
        const audit = await auditRepository.appendWithClient(client, auditEventForPrevious(previousEnabled));
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return applied.state.entries.find((entry) => entry.capabilityId === capabilityId);
      });
    },
  });
}
