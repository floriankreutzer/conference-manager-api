import { normalizeSyntheticHandoffScope,syntheticDelegationIdentityReference,SYNTHETIC_HANDOFF_COMPLETION_SECONDS }
  from '../../domain/synthetic-handoff.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { tenantAuthorizationSnapshot } from '../../authorization/policy.js';
import { hasSessionCookie } from '../../identity/session-cookie.js';
import { createPostgresSyntheticCustomerAccessRepository } from './synthetic-customer-access-repository.js';
import { withPostgresTransaction } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';

function deny(code='SYNTHETIC_HANDOFF_DENIED') { throw new Error(code); }
function codeBinding(row) { return { flowId: row.id,browserVerifier: row.browser_verifier,codeVerifier: row.code_verifier }; }

// Private Customer half. The owned root supplies the namespace-bound ordinary
// session service; HTTP may expose only closed confirmation data or committed
// cookie/redirect results. Callback GET never issues a Customer session.
export function createPostgresSyntheticCustomerHandoffRepository(pool,{ scope,browserBinding,sessionService }={}) {
  scope=normalizeSyntheticHandoffScope(scope);
  if (typeof pool?.connect!=='function' || typeof pool?.query!=='function'
    || ['stateVerifier','matchesBrowser','matchesCode','issueCompletion','matchesCompletion','completionCsrf','verifyCompletionCsrf']
      .some(name=>typeof browserBinding?.[name]!=='function')
    || ['resolvePrincipal','issue','revoke','clearCookie'].some(name=>typeof sessionService?.[name]!=='function')) {
    throw new TypeError('SYNTHETIC_CUSTOMER_HANDOFF_CONFIGURATION_INVALID');
  }
  const protection={ environment: scope.environment,securityEpoch: scope.securityEpoch };
  const access=createPostgresSyntheticCustomerAccessRepository(pool,{ scope });
  async function now(client) {
    const value=(await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) deny();return value;
  }
  async function approved(client,flowId) {
    if (!isInternalUuid(flowId)) deny();
    const row=await access.currentWithClient(client,flowId);
    if (!row || row.status!=='approved' || !(row.code_expires_at instanceof Date) || !(row.expires_at instanceof Date)) deny();
    const time=await now(client);if (row.code_expires_at<=time || row.expires_at<=time) deny();
    return { row,time };
  }
  function requireCompletion(row,time,{ browserToken,completion }) {
    if (!browserBinding.matchesCompletion({ binding: codeBinding(row),browserToken,value: completion,now: time })) deny();
  }
  async function replacement(client,request,owner) {
    if (!hasSessionCookie(request?.headers)) return null;
    const principal=await sessionService.resolvePrincipal(request);
    // A REAL or unknown cookie must be explicitly logged out. No overwritten
    // genuine session, even if login happened after callback GET in another tab.
    if (!principal || principal.providerIdentity.provider!=='platform_delegation') deny('SYNTHETIC_HANDOFF_LOGOUT_REQUIRED');
    const result=await client.query({ name: 'synthetic-handoff-own-replacement-custody',text: `SELECT custody.generation_id,
        custody.operator_id,custody.selected_role FROM synthetic_customer_handoffs custody
      JOIN sessions session ON session.id=custody.customer_session_id AND session.tenant_id=custody.tenant_id
        AND session.user_id=custody.user_id
      WHERE custody.environment=$1 AND custody.security_epoch=$2 AND custody.platform_security_epoch=$3
        AND custody.customer_origin=$4 AND custody.platform_origin=$5 AND custody.status='consumed' AND custody.operator_id=$6
        AND session.id=$7 AND session.tenant_id=$8 AND session.user_id=$9 AND session.principal_version=$10
        AND session.provider='platform_delegation' AND session.provider_identity_reference=$11
        AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp() LIMIT 1`,
    values: [scope.environment,scope.securityEpoch,scope.platformSecurityEpoch,scope.customerOrigin,scope.platformOrigin,owner,
      principal.session.id,principal.tenantId,principal.userId,principal.session.securityVersion,principal.providerIdentity.reference] });
    const row=result.rows[0];
    if (result.rowCount!==1 || syntheticDelegationIdentityReference({ generationId: row.generation_id,
      operatorId: row.operator_id,role: row.selected_role })!==principal.providerIdentity.reference) {
      deny('SYNTHETIC_HANDOFF_LOGOUT_REQUIRED');
    }
    // Replacement custody grants revocation only, never application access.
    // The old source MFA may have just been revoked by the new exact proof.
    return principal;
  }
  async function lock(client,row,previous) {
    const source=await client.query({ name: 'synthetic-handoff-redeem-source-custody-lock',text:
      'SELECT public.protected_lock_synthetic_handoff_source($1,$2,$3) AS locked',
    values: [scope.environment,scope.securityEpoch,row.id] });
    if (source.rowCount!==1 || source.rows[0]?.locked!==true) deny();
    // Same-owner role/slot switches can span Tenants. Deterministic ordering
    // prevents A->B/B->A inversion while canonical revoke/issue joins this TX.
    const tenants=[...new Set([row.tenant_id,...(previous ? [previous.tenantId] : [])])].sort();
    for (const tenantId of tenants) {
      const result=await client.query({ name: 'synthetic-handoff-redeem-tenant-lock',text:
        'SELECT id FROM tenants WHERE id=$1 FOR SHARE',values: [tenantId] });
      if (result.rowCount!==1) deny();
    }
    const people=[{ tenantId: row.tenant_id,userId: row.user_id },...(previous
      ? [{ tenantId: previous.tenantId,userId: previous.userId }] : [])]
      .sort((a,b)=>`${a.tenantId}:${a.userId}`.localeCompare(`${b.tenantId}:${b.userId}`));
    for (const person of people) {
      const result=await client.query({ name: 'synthetic-handoff-redeem-user-lock',text:
        'SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND active=true FOR SHARE',values: [person.tenantId,person.userId] });
      if (result.rowCount!==1) deny();
    }
    if (previous) {
      const session=await client.query({ name: 'synthetic-handoff-redeem-previous-lock',text:
        'SELECT id FROM sessions WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND revoked_at IS NULL FOR UPDATE',
      values: [previous.session.id,previous.tenantId,previous.userId] });
      if (session.rowCount!==1) deny('SYNTHETIC_HANDOFF_LOGOUT_REQUIRED');
    }
    const flow=await client.query({ name: 'synthetic-handoff-redeem-flow-lock',text:
      "SELECT id FROM synthetic_customer_handoffs WHERE environment=$1 AND id=$2 AND status='approved' FOR UPDATE",
    values: [scope.environment,row.id] });
    if (flow.rowCount!==1) deny();
  }
  return Object.freeze({
    async callback({ flowId,state,code,browserToken }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      return withPostgresTransaction(pool,async client=>{
        const { row,time }=await approved(client,flowId);
        if (browserBinding.stateVerifier(state)!==row.state_hash
          || !browserBinding.matchesBrowser({ flowId: row.id,browserToken,browserVerifier: row.browser_verifier })
          || !browserBinding.matchesCode({ flowId: row.id,code,codeVerifier: row.code_verifier })) deny();
        const expiresAt=new Date(Math.min(row.code_expires_at.getTime(),time.getTime()+SYNTHETIC_HANDOFF_COMPLETION_SECONDS*1000));
        const completion=browserBinding.issueCompletion({ binding: codeBinding(row),browserToken,now: time,expiresAt });
        return Object.freeze({ status: 'confirmation',completion: completion.value,expiresAt: expiresAt.toISOString() });
      });
    },
    async confirmation({ flowId,browserToken,completion }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      return withPostgresTransaction(pool,async client=>{
        const { row,time }=await approved(client,flowId);requireCompletion(row,time,{ browserToken,completion });
        return Object.freeze({ slot: row.slot,role: row.selected_role,
          csrfToken: browserBinding.completionCsrf({ binding: codeBinding(row),value: completion }) });
      });
    },
    async logout({ flowId,browserToken,completion,csrfToken,request,correlationId }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      if (!isInternalUuid(correlationId)) deny();
      return withPostgresTransaction(pool,async client=>{
        const { row,time }=await approved(client,flowId);requireCompletion(row,time,{ browserToken,completion });
        if (!browserBinding.verifyCompletionCsrf({ binding: codeBinding(row),value: completion,csrfToken })) deny();
        // Explicit browser action only. Revoke the actual current protected
        // cookie's session through canonical Tenant audit. An unknown/expired
        // cookie has no authority to revoke, but may still be cleared safely.
        const principal=await sessionService.resolvePrincipal(request);
        if (principal && await sessionService.revoke(principal,{ correlationId })!==true) deny();
        return Object.freeze({ setCookie: sessionService.clearCookie() });
      });
    },
    async complete({ flowId,browserToken,completion,csrfToken,request,correlationId }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      if (!isInternalUuid(correlationId)) deny();
      return withPostgresTransaction(pool,async client=>{
        const initial=await approved(client,flowId);requireCompletion(initial.row,initial.time,{ browserToken,completion });
        if (!browserBinding.verifyCompletionCsrf({ binding: codeBinding(initial.row),value: completion,csrfToken })) deny();
        const previous=await replacement(client,request,initial.row.operator_id);
        await lock(client,initial.row,previous);
        const { row,time }=await approved(client,flowId);requireCompletion(row,time,{ browserToken,completion });
        // Recheck current cookie custody after all locks before either revoke or
        // issue; the request's cookie is the account-switch decision point.
        const lockedPrevious=await replacement(client,request,row.operator_id);
        if ((lockedPrevious?.session.id ?? null)!==(previous?.session.id ?? null)) deny('SYNTHETIC_HANDOFF_LOGOUT_REQUIRED');
        if (previous && await sessionService.revoke(previous,{ correlationId })!==true) deny();
        const authorization=tenantAuthorizationSnapshot(row.selected_role==='employee' ? ['employee'] : ['employee',row.selected_role]);
        const session=await sessionService.issue({ tenantId: row.tenant_id,userId: row.user_id,
          providerIdentity: { provider: 'platform_delegation',reference: syntheticDelegationIdentityReference({
            generationId: row.generation_id,operatorId: row.operator_id,role: row.selected_role }) },
          ...authorization,securityVersion: Number(row.user_security_version) },{ correlationId });
        const result=await client.query({ name: 'synthetic-handoff-consume',text: `UPDATE synthetic_customer_handoffs
          SET status='consumed',customer_session_id=$3,consumed_at=clock_timestamp() WHERE environment=$1 AND id=$2
            AND status='approved' AND code_expires_at>clock_timestamp() RETURNING id`,
        values: [scope.environment,row.id,session.principal.session.id] });
        if (result.rowCount!==1 || result.rows[0]?.id!==row.id) deny();
        return session;
      });
    },
  });
}
