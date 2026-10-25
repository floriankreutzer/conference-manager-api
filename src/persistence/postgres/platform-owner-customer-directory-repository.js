import { normalizeOwnerCustomerAccessScope } from '../../domain/owner-customer-handoff.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { createPostgresOwnerCustomerSourceCustody } from './platform-owner-customer-source-custody.js';
import { withPostgresTransaction } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';

const LIMIT=50;

// Authentication and original bootstrap/all-role receipts are checked before
// any target is enumerated. This bounded directory grants no target or proof.
export function createPostgresOwnerCustomerDirectoryRepository(pool,{ scope: rawScope }={}) {
  const scope=normalizeOwnerCustomerAccessScope(rawScope),source=createPostgresOwnerCustomerSourceCustody(pool,{ scope });
  const protection={ environment: scope.environment,securityEpoch: scope.securityEpoch };
  return Object.freeze({
    list({ principal,afterTenantId=null }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      if (afterTenantId!==null && !isInternalUuid(afterTenantId)) throw new TypeError('OWNER_CUSTOMER_DIRECTORY_INPUT_INVALID');
      return withPostgresTransaction(pool,async client=>{
        if (!await source.ownerWithClient(client,principal)) throw new Error('OWNER_HANDOFF_DENIED');
        const result=await client.query({ name: 'owner-customer-current-real-directory',text: `SELECT tenant.id,
            tenant.display_name,tenant.status FROM tenants tenant JOIN tenant_runtime_registry registry
              ON registry.tenant_id=tenant.id AND registry.environment=$1 AND registry.mode='real'
          WHERE tenant.status IN ('pending','onboarding','ready','active') AND ($2::uuid IS NULL OR tenant.id>$2)
          ORDER BY tenant.id LIMIT $3`,values: [scope.environment,afterTenantId,LIMIT+1] });
        if (result.rowCount>LIMIT+1) throw new Error('OWNER_CUSTOMER_DIRECTORY_RESULT_INVALID');
        const tenants=result.rows.slice(0,LIMIT).map(row=>{
          if (!isInternalUuid(row.id) || typeof row.display_name!=='string' || row.display_name.trim().length<1
            || row.display_name.length>200 || /[\u0000-\u001f\u007f]/.test(row.display_name)
            || !['pending','onboarding','ready','active'].includes(row.status)) {
            throw new Error('OWNER_CUSTOMER_DIRECTORY_RESULT_INVALID');
          }
          return Object.freeze({ tenantId: row.id,displayName: row.display_name,status: row.status });
        });
        return Object.freeze({ tenants: Object.freeze(tenants),nextTenantId: result.rowCount>LIMIT ? tenants.at(-1).tenantId : null });
      });
    },
  });
}
