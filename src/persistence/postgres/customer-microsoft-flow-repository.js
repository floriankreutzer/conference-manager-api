import { createHash } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePrincipal } from '../../identity/principal.js';
import { normalizeCustomerMicrosoftAdmissionSnapshot } from '../../identity/customer-microsoft-admission.js';
import { withPostgresTransaction } from './transaction.js';
const HASH=/^[a-f0-9]{64}$/,TOKEN=/^[A-Za-z0-9_-]{43}$/;
const invalid=()=>{ throw new TypeError('CUSTOMER_MICROSOFT_FLOW_INPUT_INVALID'); };
function uuid(value) { if (!isInternalUuid(value)) invalid();return value.toLowerCase(); }
function digest(value) { if (typeof value!=='string' || !HASH.test(value)) invalid();return value; }
async function databaseNow(client) {
  const value=(await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('CUSTOMER_MICROSOFT_FLOW_CLOCK_INVALID');return value;
}
function expected(row) {
  return row && { tenantId: row.expected_tenant_id,userId: row.expected_user_id,membershipId: row.expected_membership_id,
    sessionId: row.expected_session_id,securityVersion: Number(row.expected_security_version) };
}
export function createPostgresCustomerMicrosoftFlowRepository(pool,{ environment,flowBinding }={}) {
  if (typeof pool?.connect!=='function' || typeof pool?.query!=='function' || !['dev','int','prod'].includes(environment)
    || typeof flowBinding?.matchesBrowser!=='function') throw new TypeError('CUSTOMER_MICROSOFT_FLOW_CONFIGURATION_INVALID');
  const globalKey=createHash('sha256').update(`customer-microsoft-global-start:v1:${environment}`).digest('hex');
  function browser(row,browserToken) {
    return row && typeof browserToken==='string' && TOKEN.test(browserToken) && flowBinding.matchesBrowser({
      context: { flowId: row.id,purpose: row.purpose,stage: 'authorization' },browserToken,browserVerifier: row.browser_verifier });
  }
  async function load(client,flowId,lock=false) {
    const result=await client.query({ name: lock ? 'customer-microsoft-flow-lock' : 'customer-microsoft-flow-read',
      text: lock ? 'SELECT * FROM customer_microsoft_flows WHERE environment=$1 AND id=$2 FOR UPDATE'
        : 'SELECT * FROM customer_microsoft_flows WHERE environment=$1 AND id=$2',values: [environment,uuid(flowId)] });
    return result.rows[0] ?? null;
  }
  async function currentEmail(client,value,expectedValue=null,lock=false) {
    let principal;try { principal=normalizePrincipal(value); } catch { return null; }
    if (principal.providerIdentity.provider!=='email_code' || expectedValue && (expectedValue.tenantId!==principal.tenantId
      || expectedValue.userId!==principal.userId || expectedValue.sessionId!==principal.session.id
      || expectedValue.securityVersion!==principal.session.securityVersion)) return null;
    if (lock) {
      const tenant=await client.query({ name: 'customer-microsoft-email-tenant-lock',text: `SELECT id FROM tenants
        WHERE id=$1 AND status IN ('pending','onboarding','ready','active') FOR UPDATE`,values: [principal.tenantId] });
      if (tenant.rowCount!==1) return null;
      const member=await client.query({ name: 'customer-microsoft-email-member-lock',text: `SELECT id FROM customer_access_memberships
        WHERE environment=$1 AND tenant_id=$2 AND user_id=$3 AND accepted_at IS NOT NULL FOR UPDATE`,
      values: [environment,principal.tenantId,principal.userId] });if (member.rowCount!==1) return null;
      const user=await client.query({ name: 'customer-microsoft-email-user-lock',text: `SELECT id FROM users
        WHERE tenant_id=$1 AND id=$2 AND active=true AND security_version=$3 FOR UPDATE`,
      values: [principal.tenantId,principal.userId,principal.session.securityVersion] });if (user.rowCount!==1) return null;
      const session=await client.query({ name: 'customer-microsoft-email-session-lock',
        text: 'SELECT id FROM sessions WHERE id=$1 FOR SHARE',
        values: [principal.session.id] });if (session.rowCount!==1) return null;
    }
    const result=await client.query({ name: 'customer-microsoft-current-email-session',text: `SELECT member.id AS membership_id,
      member.tenant_id,member.user_id,person.security_version,session.id AS session_id FROM sessions session
      JOIN users person ON person.tenant_id=session.tenant_id AND person.id=session.user_id
      JOIN tenants tenant ON tenant.id=person.tenant_id
      JOIN customer_access_memberships member ON member.environment=$1 AND member.tenant_id=person.tenant_id
        AND member.user_id=person.id AND member.accepted_at IS NOT NULL
      JOIN user_identity_bindings identity ON identity.tenant_id=person.tenant_id AND identity.user_id=person.id
        AND identity.provider='email_code' AND identity.provider_tenant_reference=$1
        AND identity.provider_user_reference=member.mailbox_id::text
      WHERE session.id=$2 AND session.tenant_id=$3 AND session.user_id=$4 AND session.provider='email_code'
        AND session.provider_identity_reference=member.mailbox_id::text AND session.principal_version=$5
        AND person.security_version=$5 AND person.active=true AND session.revoked_at IS NULL
        AND session.expires_at>clock_timestamp() AND session.issued_at<=clock_timestamp()
        AND session.issued_at>=clock_timestamp()-interval '5 minutes'
        AND tenant.status IN ('pending','onboarding','ready','active')`,
    values: [environment,principal.session.id,principal.tenantId,principal.userId,principal.session.securityVersion] });
    const row=result.rows[0];
    if (result.rowCount!==1 || expectedValue && row.membership_id!==expectedValue.membershipId) return null;
    return { tenantId: row.tenant_id,userId: row.user_id,membershipId: row.membership_id,sessionId: row.session_id,
      securityVersion: Number(row.security_version) };
  }
  async function retention(client) {
    await client.query({ name: 'customer-microsoft-flow-expired-cleanup',text: `WITH expired AS (
      SELECT id FROM customer_microsoft_flows WHERE environment=$1 AND expires_at<clock_timestamp()-interval '1 hour'
        AND NOT (purpose='link' AND status='consumed') ORDER BY expires_at,id LIMIT 20 FOR UPDATE SKIP LOCKED)
      DELETE FROM customer_microsoft_flows flow USING expired WHERE flow.environment=$1 AND flow.id=expired.id`,values: [environment] });
    await client.query({ name: 'customer-microsoft-start-budget-cleanup',text: `WITH expired AS (
      SELECT kind,key_hash FROM customer_microsoft_start_budgets WHERE environment=$1
        AND window_started_at<clock_timestamp()-interval '24 hours'
        AND last_issued_at<clock_timestamp()-interval '24 hours' ORDER BY window_started_at,kind,key_hash
        LIMIT 20 FOR UPDATE SKIP LOCKED) DELETE FROM customer_microsoft_start_budgets budget USING expired
      WHERE budget.environment=$1 AND budget.kind=expired.kind AND budget.key_hash=expired.key_hash`,values: [environment] });
  }
  async function allocate(client,sourceKey) {
    const lock=await client.query({ name: 'customer-microsoft-start-budget-lock',text:
      "SELECT pg_try_advisory_xact_lock(hashtext('customer-microsoft-start-v1'),hashtext($1)) AS locked",values: [environment] });
    if (lock.rows[0]?.locked!==true) return false;
    await retention(client);const time=await databaseNow(client);
    const previous=await client.query({ name: 'customer-microsoft-start-budget-current',text: `SELECT kind,key_hash,
      window_started_at,issue_count FROM customer_microsoft_start_budgets WHERE environment=$1
        AND ((kind='global' AND key_hash=$2) OR (kind='source' AND key_hash=$3)) FOR UPDATE`,values: [environment,globalKey,sourceKey] });
    if (previous.rows.some(row=>!(row.window_started_at instanceof Date) || row.window_started_at>time
      || time.getTime()-row.window_started_at.getTime()<60000 && row.issue_count>=(row.kind==='global' ? 30 : 5))) return false;
    for (const [kind,key] of [['global',globalKey],['source',sourceKey]]) await client.query({
      name: 'customer-microsoft-start-budget-spend',
      text: `INSERT INTO customer_microsoft_start_budgets(environment,kind,key_hash,window_started_at,issue_count,last_issued_at)
        VALUES($1,$2,$3,$4,1,$4) ON CONFLICT(environment,kind,key_hash) DO UPDATE SET
          issue_count=CASE WHEN customer_microsoft_start_budgets.window_started_at<=$4::timestamptz-interval '1 minute'
            THEN 1 ELSE customer_microsoft_start_budgets.issue_count+1 END,
          window_started_at=CASE WHEN customer_microsoft_start_budgets.window_started_at<=$4::timestamptz-interval '1 minute'
            THEN $4 ELSE customer_microsoft_start_budgets.window_started_at END,last_issued_at=$4`,values: [environment,kind,key,time] });
    return true;
  }
  return Object.freeze({
    async create(input) {
      const flowId=uuid(input.flowId),correlationId=uuid(input.correlationId),sourceKey=digest(input.sourceKey);
      digest(input.stateHash);digest(input.nonceHash);digest(input.browserVerifier);
      if (!['login','link'].includes(input.purpose) || input.purpose==='login' && input.principal!==null) invalid();
      return withPostgresTransaction(pool,async client=>{
        const email=input.purpose==='link' ? await currentEmail(client,input.principal,null,true) : null;
        if (input.purpose==='link' && !email || !await allocate(client,sourceKey)) return null;
        const time=await databaseNow(client);
        const result=await client.query({ name: 'customer-microsoft-flow-insert',text: `INSERT INTO customer_microsoft_flows
          (environment,id,purpose,state_hash,nonce_hash,browser_verifier,source_key_hash,correlation_id,created_at,expires_at,
            expected_tenant_id,expected_user_id,expected_membership_id,expected_session_id,expected_security_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9::timestamptz+interval '10 minutes',$10,$11,$12,$13,$14)
          RETURNING id,created_at`,values: [environment,flowId,input.purpose,input.stateHash,input.nonceHash,input.browserVerifier,
          sourceKey,correlationId,time,email?.tenantId ?? null,email?.userId ?? null,email?.membershipId ?? null,
          email?.sessionId ?? null,email?.securityVersion ?? null] });
        return Object.freeze({ flowId: result.rows[0].id,startedAt: result.rows[0].created_at.toISOString() });
      });
    },
    async reserve({ flowId,stateHash,browserToken,correlationId,principal }={}) {
      uuid(flowId);digest(stateHash);uuid(correlationId);
      return withPostgresTransaction(pool,async client=>{
        const flow=await load(client,flowId,true),time=await databaseNow(client);
        if (!browser(flow,browserToken) || flow.status!=='started' || flow.state_hash!==stateHash || flow.expires_at<=time
          || flow.purpose==='link' && !await currentEmail(client,principal,expected(flow))) return null;
        await client.query({ name: 'customer-microsoft-flow-reserve',text: `UPDATE customer_microsoft_flows
          SET status='redeeming',redeeming_at=$3 WHERE environment=$1 AND id=$2`,values: [environment,flowId,time] });
        return Object.freeze({ flowId: flow.id,purpose: flow.purpose,nonceHash: flow.nonce_hash,startedAt: flow.created_at.toISOString() });
      });
    },
    async fail({ flowId,browserToken,correlationId }={}) {
      uuid(flowId);uuid(correlationId);
      return withPostgresTransaction(pool,async client=>{
        const flow=await load(client,flowId,true);
        if (!browser(flow,browserToken) || !['started','redeeming'].includes(flow.status)) return false;
        await client.query({ name: 'customer-microsoft-flow-fail',text: `UPDATE customer_microsoft_flows
          SET status='failed',failed_at=clock_timestamp() WHERE environment=$1 AND id=$2`,values: [environment,flowId] });return true;
      });
    },
    async verified({ flowId,identity,choiceVerifier,browserToken,correlationId,principal }={}) {
      uuid(flowId);uuid(correlationId);digest(choiceVerifier);
      if (!identity || identity.provider!=='microsoft_entra' || Object.keys(identity).sort().join(',')
        !=='authenticatedAt,provider,tenantReference,userReference') invalid();
      const providerTenant=uuid(identity.tenantReference),providerUser=uuid(identity.userReference);
      const authenticated=typeof identity.authenticatedAt==='string' ? new Date(identity.authenticatedAt) : null;
      if (!authenticated || !Number.isFinite(authenticated.getTime()) || authenticated.toISOString()!==identity.authenticatedAt) invalid();
      return withPostgresTransaction(pool,async client=>{
        const initial=await load(client,flowId);
        if (!browser(initial,browserToken) || initial.status!=='redeeming') return false;
        if (initial.purpose==='link' && !await currentEmail(client,principal,expected(initial),true)) return false;
        const flow=await load(client,flowId,true),time=await databaseNow(client);
        if (!browser(flow,browserToken) || flow.status!=='redeeming' || flow.expires_at<=time
          || authenticated.getTime()<Math.max(flow.created_at.getTime()-60000,time.getTime()-360000)
          || authenticated.getTime()>time.getTime()+60000 || providerTenant==='9188040d-6c67-4c5b-b112-36a304b66dad') return false;
        let snapshot=[];
        if (flow.purpose==='login') {
          const result=await client.query({ name: 'customer-microsoft-admission-capture',text: `SELECT member.id AS membership_id,
            member.tenant_id,member.user_id,person.security_version FROM customer_access_memberships member
            JOIN users person ON person.tenant_id=member.tenant_id AND person.id=member.user_id
            JOIN tenants tenant ON tenant.id=person.tenant_id JOIN user_identity_bindings identity
              ON identity.tenant_id=person.tenant_id AND identity.user_id=person.id AND identity.provider='microsoft_entra'
              AND identity.provider_tenant_reference=$2 AND identity.provider_user_reference=$3
            WHERE member.environment=$1 AND member.accepted_at IS NOT NULL AND person.active=true
              AND tenant.status IN ('pending','onboarding','ready','active') ORDER BY member.tenant_id,member.id LIMIT 101`,
          values: [environment,providerTenant,providerUser] });
          snapshot=normalizeCustomerMicrosoftAdmissionSnapshot(result.rows.map(row=>({ membershipId: row.membership_id,
            tenantId: row.tenant_id,userId: row.user_id,userSecurityVersion: Number(row.security_version) })));
        }
        await client.query({ name: 'customer-microsoft-flow-verified',text: `UPDATE customer_microsoft_flows
          SET status='verified',verified_at=$3,choice_verifier=$4,provider_tenant_reference=$5,provider_user_reference=$6,
            authenticated_at=$7,admission_snapshot=$8::jsonb WHERE environment=$1 AND id=$2`,
        values: [environment,flowId,time,choiceVerifier,providerTenant,providerUser,authenticated,JSON.stringify(snapshot)] });return true;
      });
    },
  });
}
