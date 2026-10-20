import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { protectPlatformPasskeyRoute } from '../src/platform/http/passkey-operation-route.js';
import { platformTenantRoutes,createPlatformTenantRoutes } from '../src/platform/http/tenant-routes.js';
import { platformAuditRoutes } from '../src/platform/http/audit-routes.js';
import { PlatformIdentityError } from '../src/platform/identity/errors.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { serializePlatformPasskeyTransactionCookie, clearPlatformPasskeyTransactionCookie }
  from '../src/platform/identity/passkey-auth-cookie.js';
import { serializePlatformPasskeyOperationCookie, readPlatformPasskeyOperationCookie,
  clearPlatformPasskeyOperationCookie } from '../src/platform/identity/passkey-operation-cookie.js';
import { serializePlatformSessionCookie } from '../src/platform/identity/session-cookie.js';

const ID = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const state = Buffer.alloc(32, 1).toString('base64url'); const browser = Buffer.alloc(32, 2).toString('base64url');
const operationCookie = serializePlatformPasskeyOperationCookie(`${state}.${browser}`);
const normalCookie = serializePlatformSessionCookie('P'.repeat(43), { secure: true, maxAgeSeconds: 3600 });
const now = new Date().toISOString(); const roles = ['platform_security_admin'];
const principal = { operatorId: ID, securityVersion: 4,
  providerIdentity: { provider: 'microsoft_entra_platform', tenantReference: ID, subjectReference: OTHER },
  roles, permissions: permissionsForPlatformRoles(roles), targetScope: { mode: 'all', securityVersion: 4 },
  assurance: { level: 'mfa', authenticationContext: 'cm:pk:v1', authenticatedAt: now },
  session: { id: SESSION, securityVersion: 4, securityEpoch: 8, issuedAt: now,
    expiresAt: new Date(Date.now() + 3600000).toISOString(), stepUpExpiresAt: null } };
const strong = { ...principal, assurance: { ...principal.assurance, level: 'step_up' },
  session: { ...principal.session, id: OTHER, stepUpExpiresAt: new Date(Date.now() + 120000).toISOString() } };
const body = { displayName: 'Synthetic customer', reason: 'Synthetic authorized onboarding',
  confirmation: { action: 'tenant.invitation.create', displayName: 'Synthetic customer' } };
const encodedProof = Buffer.from(JSON.stringify({ state, response: { signed: true } })).toString('base64url');
function response() {
  return { headers: {}, statusCode: 200, body: null, setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = JSON.parse(value); } };
}
function fixture(module = platformTenantRoutes,platformCustomerOnboardingService=null,
  platformCustomerInvitationAdministrationService=null) {
  let pending = null; let failCommit = false; let failMutation = false; let csrf = true; let denied = 0;
  const contexts = new WeakSet(); const mutations = []; const challenges = []; let current = principal;
  const authService = {
    async startStepUp(value, binding) { challenges.push({ value, binding }); pending = binding.operationHash;
      return { status: 'passkey_required', state, options: { challenge: browser },
        setCookie: serializePlatformPasskeyTransactionCookie(`${state}.${browser}`) }; },
    async executeStepUp(value, work) {
      if (value.state !== state || value.cookie !== `${state}.${browser}` || value.response.signed !== true
        || value.operationHash !== pending || !pending) throw new PlatformIdentityError('PLATFORM_PASSKEY_AUTHENTICATION_REJECTED');
      const context = Object.freeze({ principal: strong, operationHash: pending }); contexts.add(context);
      let result; try { result = await work(context); } finally { contexts.delete(context); }
      if (failCommit) throw new Error('SYNTHETIC_COMMIT_FAILURE'); pending = null;
      return { status: 'operation_completed', result, principal, csrfToken: 'C'.repeat(43),
        setCookies: [normalCookie,clearPlatformPasskeyTransactionCookie()] };
    },
    verifiedOperationPrincipal(context, expected) {
      if (!contexts.has(context) || context.operationHash !== expected) throw new Error('OPAQUE_CONTEXT_REJECTED');
      contexts.delete(context); return context.principal;
    },
  };
  const runtime = {
    platformCustomerOnboardingService,
    platformCustomerInvitationAdministrationService,
    maxBodyBytes: 32768, maxResponseBytes: 65536,
    platformPrincipalGuard: { async require(request, options) {
      if (!current || request.headers.cookie?.includes('cm_platform_session=') !== true) {
        throw new PlatformIdentityError('PLATFORM_SESSION_REQUIRED');
      }
      if (options.csrf && !csrf) throw new PlatformIdentityError('PLATFORM_CSRF_INVALID');
      return current;
    } },
    platformTenantOperationsService: { async listDirectory() { return {}; },
      async createTenantInvitation(value) {
        assert.equal(value.operatorContext.assurance.level, 'step_up'); mutations.push(value);
        if (failMutation) throw new Error('SYNTHETIC_POLICY_DENIAL');
        return { outcome: 'updated', synthetic: true };
      }, async revokeInvitation() {}, async reissueInvitation() {}, async transitionLifecycle() {} },
    platformAuditService: { async list() { return []; }, async export(value) {
      assert.equal(value.principal.assurance.level, 'step_up'); mutations.push(value); return [];
    }, createDeniedEvent: value => value, async record(value) {
      assert.equal(value.metadata.reasonCode, 'passkey_rejected'); denied++;
    } },
  };
  const handler = protectPlatformPasskeyRoute(module, { authService, environment: 'int', securityEpoch: 8 }).createHandler(runtime);
  async function invoke({ method = 'POST', path = '/api/v1/platform/tenants', value = body, proof,
    idempotencyKey = ID, cookie = `${normalCookie.split(';')[0]}; ${operationCookie.split(';')[0]}` } = {}) {
    const serialized = method === 'GET' ? null : JSON.stringify(value);
    const request = Readable.from(serialized === null ? [] : [Buffer.from(serialized)]);
    request.method = method; request.headers = { cookie, ...(serialized === null ? {} : { 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(serialized)) }), 'idempotency-key': idempotencyKey,
      ...(proof === undefined ? {} : { 'x-platform-passkey-proof': proof }) };
    const out = response();
    try { await handler({ path: path.split('?')[0], parsedUrl: new URL(path, 'https://ops-int.example.com'),
      request, response: out, requestId: OTHER }); return out; }
    catch (error) { return { ...out, error }; }
  }
  return { invoke, mutations, challenges, denied: () => denied, failCommit: () => { failCommit = true; },
    failMutation: () => { failMutation = true; }, setCsrf: value => { csrf = value; }, setCurrent: value => { current = value; } };
}

test('an existing concrete mutation gets a fresh exact proof, original validation and one ordinary session after commit', async () => {
  const f = fixture(); const first = await f.invoke(); assert.equal(first.statusCode, 428); assert.equal(f.mutations.length, 0);
  assert.deepEqual(first.headers['set-cookie'], operationCookie); assert.equal(first.body.status, 'passkey_required');
  const complete = await f.invoke({ proof: encodedProof });
  assert.equal(complete.statusCode, 201); assert.deepEqual(complete.body, { outcome: 'updated', synthetic: true });
  assert.deepEqual(complete.headers['set-cookie'], [normalCookie,clearPlatformPasskeyOperationCookie()]);
  assert.equal(f.mutations.length, 1); assert.equal(f.mutations[0].idempotencyKey, ID);
  assert.equal((await f.invoke({ proof: encodedProof })).error.statusCode, 403); assert.equal(f.mutations.length, 1);
});

test('body, idempotency, method/target, live session and cookie substitutions cannot repurpose a pending proof', async () => {
  const f = fixture(); await f.invoke();
  for (const changes of [{ value: { ...body, displayName: 'Other customer' } }, { idempotencyKey: OTHER },
    { path: `/api/v1/platform/tenants/${OTHER}/lifecycle/transitions` },
    { cookie: `${normalCookie.split(';')[0]}; cm_platform_passkey_tx=${state}.${browser}` }]) {
    assert.equal((await f.invoke({ ...changes, proof: encodedProof })).error.statusCode, 403);
  }
  assert.equal(f.mutations.length, 0); assert.equal(f.denied(), 4);
  f.setCsrf(false); assert.ok((await f.invoke({ proof: encodedProof })).error); f.setCsrf(true);
  f.setCurrent({ ...principal, session: { ...principal.session, id: OTHER } });
  assert.equal((await f.invoke({ proof: encodedProof })).error.statusCode, 403);
  f.setCurrent({ ...principal, session: { ...principal.session, securityEpoch: 9 } });
  assert.equal((await f.invoke()).error.statusCode, 403); assert.equal(f.mutations.length, 0);
});

test('original positive body/policy errors and failed commit cannot send a successful response or session cookie', async () => {
  const invalid = fixture(); await invalid.invoke({ value: { ...body, roles: ['platform_security_admin'] } });
  const rejected = await invalid.invoke({ proof: encodedProof, value: { ...body, roles: ['platform_security_admin'] } });
  assert.equal(rejected.error.statusCode, 400); assert.equal(rejected.body, null); assert.equal(invalid.mutations.length, 0);
  for (const cause of ['failMutation','failCommit']) {
    const f = fixture(); await f.invoke(); f[cause](); const result = await f.invoke({ proof: encodedProof });
    assert.ok(result.error); assert.equal(result.body, null); assert.equal(result.headers['set-cookie'], undefined);
  }
});

test('protected audit export binds its exact query and requires normal CSRF even though the business endpoint is GET', async () => {
  const f = fixture(platformAuditRoutes); const path = '/api/v1/platform/audit/exports?limit=10';
  f.setCsrf(false); assert.ok((await f.invoke({ method: 'GET', path })).error); assert.equal(f.challenges.length, 0);
  f.setCsrf(true); assert.equal((await f.invoke({ method: 'GET', path })).statusCode, 428);
  assert.equal((await f.invoke({ method: 'GET', path: `${path}0`, proof: encodedProof })).error.statusCode, 403);
  const result = await f.invoke({ method: 'GET', path, proof: encodedProof });
  assert.equal(result.statusCode, 200); assert.deepEqual(result.body, { schemaVersion: 1, items: [] });
  assert.equal(f.mutations.length, 1); assert.equal(f.mutations[0].limit, 10);
});

test('temporary operation cookies remain exact, HttpOnly and separate from login, enrollment and business authority', () => {
  assert.equal(readPlatformPasskeyOperationCookie({ cookie: operationCookie.split(';')[0] }), `${state}.${browser}`);
  assert.equal(readPlatformPasskeyOperationCookie({ cookie: `${operationCookie.split(';')[0]}; ${operationCookie.split(';')[0]}` }), null);
  assert.equal(readPlatformPasskeyOperationCookie({ cookie: `cm_platform_passkey_tx=${state}.${browser}` }), null);
  assert.equal(readPlatformPasskeyOperationCookie({ cookie: 'x'.repeat(8193) }), null);
  assert.match(operationCookie, /Path=\/api\/v1\/platform; HttpOnly; Secure; SameSite=Strict; Max-Age=120$/);
  assert.doesNotMatch(operationCookie, /Domain=/); assert.throws(() => serializePlatformPasskeyOperationCookie('invalid'), /INVALID/);
});

test('malformed proof headers and complex bodies fail before creating or executing application authority', async () => {
  const f = fixture(); await f.invoke();
  for (const proof of ['invalid=', 'a'.repeat(12001), Buffer.from('not-json').toString('base64url'),
    Buffer.from(JSON.stringify({ state, response: {}, roles: ['platform_security_admin'] })).toString('base64url')]) {
    const result = await f.invoke({ proof }); assert.ok(result.error); assert.equal(result.body, null);
  }
  let nested = {};
  for (let n = 0; n < 10; n++) nested = { nested };
  assert.ok((await f.invoke({ value: { ...body, nested } })).error);
  assert.equal(f.challenges.length, 1); assert.equal(f.mutations.length, 0);
});


test('real onboarding port binds each recipient, Customer role and locale to the exact operation proof',async()=>{
  const calls=[];
  const service={ async createTenant(value) { calls.push(value);return { outcome: 'updated',schemaVersion: 1 }; } };
  const f=fixture(platformTenantRoutes,service);
  const value={ ...body,invitations: [{ recipient: 'Operator@example.test',roles: ['tenant_admin'],locale: 'de' }] };
  assert.equal((await f.invoke({ value })).statusCode,428);assert.equal(calls.length,0);
  for (const replacement of [{ recipient: 'Other@example.test' },{ roles: ['conference_manager'] },{ locale: 'en' }]) {
    const altered={ ...value,invitations: [{ ...value.invitations[0],...replacement }] };
    assert.equal((await f.invoke({ value: altered,proof: encodedProof })).error.statusCode,403);
  }
  const result=await f.invoke({ value,proof: encodedProof });assert.equal(result.statusCode,201);
  assert.equal(calls.length,1);assert.equal(calls[0].operatorContext.assurance.level,'step_up');
  assert.deepEqual(calls[0].invitations,value.invitations);assert.equal(calls[0].idempotencyKey,ID);
  assert.equal(f.mutations.length,0); // Legacy creation is never used as a fallback.
});

test('onboarding body mode is explicit, bounded and never falls back after service failure',async()=>{
  const original=fixture();const value={ ...body,invitations: [] };
  await original.invoke({ value });assert.equal((await original.invoke({ value,proof: encodedProof })).error.statusCode,400);
  let calls=0;
  const service={ async createTenant() { calls++;throw new Error('SYNTHETIC_ONBOARDING_FAILED'); } };
  for (const invalid of [body,{ ...value,invitations: Array(20).fill({}) },{ ...value,ownerRecipient: 'Other@example.test' }]) {
    const f=fixture(platformTenantRoutes,service);await f.invoke({ value: invalid });
    assert.equal((await f.invoke({ value: invalid,proof: encodedProof })).error.statusCode,400);
    assert.equal(f.mutations.length,0);
  }
  assert.equal(calls,0);
  const f=fixture(platformTenantRoutes,service);await f.invoke({ value });
  const result=await f.invoke({ value,proof: encodedProof });assert.match(result.error.message,/SYNTHETIC_ONBOARDING_FAILED/);
  assert.equal(calls,1);assert.equal(f.mutations.length,0);assert.equal(result.body,null);
  assert.equal(result.headers['set-cookie'],undefined);
  assert.throws(()=>fixture(platformTenantRoutes,{}),/ONBOARDING_SERVICE_REQUIRED/);
});


test('explicit invitation administration binds list pagination and additional invitees to fresh concrete proofs',async()=>{
  const calls=[],module=createPlatformTenantRoutes({ invitationAdministration: true });
  const admin={ async list(value){ calls.push(['list',value]);return { schemaVersion: 1,items: [] }; },
    async issueBatch(value){ calls.push(['issue',value]);return { outcome: 'updated',invitations: [] }; },
    async reissue(){},async revoke(){} };
  const f=fixture(module,{ async createTenant(){} },admin),path=`/api/v1/platform/tenants/${ID}/invitations`;
  f.setCsrf(false);assert.ok((await f.invoke({ method: 'GET',path })).error);assert.equal(calls.length,0);
  f.setCsrf(true);assert.equal((await f.invoke({ method: 'GET',path: `${path}?limit=5` })).statusCode,428);
  assert.equal((await f.invoke({ method: 'GET',path: `${path}?limit=6`,proof: encodedProof })).error.statusCode,403);
  const listed=await f.invoke({ method: 'GET',path: `${path}?limit=5`,proof: encodedProof });
  assert.equal(listed.statusCode,200);assert.equal(calls[0][0],'list');assert.equal(calls[0][1].tenantId,ID);
  assert.equal(calls[0][1].limit,5);assert.equal(calls[0][1].afterInvitationId,null);
  const value={ reason: body.reason,confirmation: { action: 'tenant.invitation.create',tenantId: ID },
    invitations: [{ recipient: 'Additional@example.test',roles: ['tenant_admin'],locale: 'en' }] };
  assert.equal((await f.invoke({ path,value })).statusCode,428);
  assert.equal((await f.invoke({ path,value,proof: encodedProof })).statusCode,201);
  assert.equal(calls[1][0],'issue');assert.deepEqual(calls[1][1].invitations,value.invitations);
  assert.equal(calls[1][1].operatorContext.assurance.level,'step_up');assert.equal(f.mutations.length,0);
  assert.equal(platformTenantRoutes.claim({ method: 'GET',path }),null);
});

test('explicit administration uses real-custody resend/revoke ports, closed queries and mandatory composition',async()=>{
  const module=createPlatformTenantRoutes({ invitationAdministration: true }),calls=[];
  const admin={ async list(){},async issueBatch(){},async reissue(value){ calls.push(['reissue',value]);return { outcome: 'updated' }; },
    async revoke(value){ calls.push(['revoke',value]);return { outcome: 'updated' }; } };
  const f=fixture(module,{ async createTenant(){} },admin),path=`/api/v1/platform/tenants/${ID}/invitations/${OTHER}`;
  for (const [method,suffix,action] of [['POST','/reissue','reissue'],['DELETE','','revoke']]) {
    const value={ expectedRevision: 1,reason: body.reason,confirmation: { action: `tenant.invitation.${action}`,tenantId: ID } };
    assert.equal((await f.invoke({ method,path: path+suffix,value })).statusCode,428);
    assert.equal((await f.invoke({ method,path: path+suffix,value,proof: encodedProof })).statusCode,200);
  }
  assert.deepEqual(calls.map(item=>item[0]),['reissue','revoke']);assert.equal(f.mutations.length,0);
  assert.equal(calls[0][1].invitationId,OTHER);assert.equal(calls[1][1].expectedRevision,1);
  for (const query of ['limit=0','limit=101','limit=1&limit=2','afterId=invalid','tenantId=foreign']) {
    const invalid=fixture(module,{ async createTenant(){} },admin),url=`/api/v1/platform/tenants/${ID}/invitations?${query}`;
    await invalid.invoke({ method: 'GET',path: url });
    assert.equal((await invalid.invoke({ method: 'GET',path: url,proof: encodedProof })).error.statusCode,400);
  }
  assert.throws(()=>fixture(module,{ async createTenant(){} }),/ADMINISTRATION_REQUIRED/);
  assert.throws(()=>createPlatformTenantRoutes({ invitationAdministration: 'true' }),/CONFIGURATION_INVALID/);
});
