import { withPostgresTransaction } from './transaction.js';

const DEFAULT_POLICY = Object.freeze({ mode: 'optional', defaultCostCenterId: null });

export function createPostgresTenantCostAllocationRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') throw new TypeError('AUDIT_REPOSITORY_REQUIRED');

  async function read(tenantId, client = pool) {
    const [tenant, policy, centers] = await Promise.all([
      client.query({ name: 'tenant-cost-allocation-revision-get', text: 'SELECT cost_allocation_revision FROM tenants WHERE id=$1', values: [tenantId] }),
      client.query({ name: 'tenant-cost-allocation-policy-get', text: 'SELECT mode,default_cost_center_id FROM tenant_cost_allocation_policies WHERE tenant_id=$1', values: [tenantId] }),
      client.query({
        name: 'tenant-cost-centers-get',
        text: `SELECT id,code,name,description,active,sort_order
               FROM cost_centers WHERE tenant_id=$1 ORDER BY sort_order,code,id`,
        values: [tenantId],
      }),
    ]);
    if (!tenant.rows[0]) return null;
    const policyRow = policy.rows[0];
    return Object.freeze({
      revision: Number(tenant.rows[0].cost_allocation_revision),
      costAllocation: Object.freeze({
        mode: policyRow?.mode ?? DEFAULT_POLICY.mode,
        defaultCostCenterId: policyRow?.default_cost_center_id ?? null,
        costCenters: Object.freeze(centers.rows.map((row) => Object.freeze({
          id: row.id,
          code: row.code,
          name: row.name,
          description: row.description ?? null,
          active: row.active,
          sortOrder: row.sort_order,
        }))),
      }),
    });
  }

  return Object.freeze({
    get: (tenantId) => read(tenantId),
    async update({ tenantId, expectedRevision, costAllocation, changedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const locked = await client.query({
          name: 'tenant-cost-allocation-lock',
          text: 'SELECT cost_allocation_revision FROM tenants WHERE id=$1 FOR UPDATE',
          values: [tenantId],
        });
        if (!locked.rows[0]) return null;
        const currentRevision = Number(locked.rows[0].cost_allocation_revision);
        if (currentRevision !== expectedRevision) return Object.freeze({ conflict: true, currentRevision });

        for (const center of costAllocation.costCenters) {
          await client.query({
            name: 'tenant-cost-center-upsert',
            text: `
              INSERT INTO cost_centers (
                tenant_id,id,code,name,description,active,sort_order,created_at,updated_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
              ON CONFLICT (tenant_id,id) DO UPDATE SET
                code=EXCLUDED.code,name=EXCLUDED.name,description=EXCLUDED.description,
                active=EXCLUDED.active,sort_order=EXCLUDED.sort_order,updated_at=EXCLUDED.updated_at
            `,
            values: [tenantId,center.id,center.code,center.name,center.description,center.active,center.sortOrder,changedAt],
          });
        }
        if (costAllocation.defaultCostCenterId !== null) {
          const defaultCenter = await client.query({
            name: 'tenant-cost-allocation-default-check',
            text: 'SELECT 1 FROM cost_centers WHERE tenant_id=$1 AND id=$2 AND active=true',
            values: [tenantId,costAllocation.defaultCostCenterId],
          });
          if (!defaultCenter.rows[0]) return Object.freeze({ protectedReference: true });
        }
        await client.query({
          name: 'tenant-cost-allocation-policy-upsert',
          text: `
            INSERT INTO tenant_cost_allocation_policies (tenant_id,mode,default_cost_center_id,updated_at)
            VALUES ($1,$2,$3,$4)
            ON CONFLICT (tenant_id) DO UPDATE SET
              mode=EXCLUDED.mode,default_cost_center_id=EXCLUDED.default_cost_center_id,updated_at=EXCLUDED.updated_at
          `,
          values: [tenantId,costAllocation.mode,costAllocation.defaultCostCenterId,changedAt],
        });
        await client.query({
          name: 'tenant-cost-allocation-revision-advance',
          text: 'UPDATE tenants SET cost_allocation_revision=cost_allocation_revision+1, updated_at=$2 WHERE id=$1',
          values: [tenantId, changedAt],
        });
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return read(tenantId, client);
      });
    },
  });
}
