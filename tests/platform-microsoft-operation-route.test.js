import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { protectPlatformMicrosoftRoute } from '../src/platform/http/microsoft-operation-route.js';
import { platformTenantRoutes } from '../src/platform/http/tenant-routes.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { PlatformIdentityError } from '../src/platform/identity/errors.js';
import { serializePlatformMicrosoftOperationBrowserCookie,serializePlatformMicrosoftOperationCookie,
  clearPlatformMicrosoftOperationCookie } from '../src/platform/identity/microsoft-operation-cookie.js';

const id='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222';
const state=Buffer.alloc(32,1).toString('base64url'),browser=Buffer.alloc(32,2).toString('base64url');
const origin='https://operations.example.test',authority=`https://login.microsoftonline.com/${id}`;
const cookies=[serializePlatformMicrosoftOperationBrowserCookie(`${state}.${browser}`),
  serializePlatformMicrosoftOperationCookie(`${state}.${browser}`,120)];
const normal='cm_platform_session=synthetic-normal; Path=/api/v1/platform; HttpOnly; Secure; SameSite=Strict';
const roles=['platform_security_admin'],now=new Date().toISOString();
const principal={ operatorId: id,securityVersion: 1,roles,permissions: permissionsForPlatformRoles(roles),
  targetScope: { mode: 'all',securityVersion: 1 },providerIdentity: { provider: 'microsoft_entra_platform',
    tenantReference: id,subjectReference: session },assurance: { level: 'mfa',authenticationContext: 'cm:ms:mfa:v1',authenticatedAt: now },
  session: { id: session,securityVersion: 1,securityEpoch: 7,issuedAt: now,
    expiresAt: new Date(Date.now()+3600000).toISOString(),stepUpExpiresAt: null } };
const body={ displayName: 'Synthetic customer',reason: 'Synthetic authorized onboarding',
  confirmation: { action: 'tenant.invitation.create',displayName: 'Synthetic customer' } };
function authorizationUrl() {
  const url=new URL(`${authority}/oauth2/v2.0/authorize`);
  for (const [key,value] of Object.entries({ client_id: id,
    redirect_uri: origin+'/api/v1/platform/auth/microsoft/operation/callback',scope: 'openid profile',
    response_type: 'code',response_mode: 'query',max_age: '0',prompt: 'login',state,nonce: browser,
    code_challenge: browser,code_challenge_method: 'S256',claims: JSON.stringify({ id_token: {
      auth_time: { essential: true },amr: { essential: true,values: ['mfa'] } } }) })) url.searchParams.set(key,value);
  return url.toString();
}
function fixture() {
  let pending=null,writes=0,csrf=true,current=principal,failure=false,denials=0;
  const contexts=new WeakMap(),auth={
    async startStepUp(_principal,{ operationHash }) { pending=operationHash;
      return { status: 'microsoft_required',state,authorizationUrl: authorizationUrl(),setCookies: cookies }; },
    async executeStepUp(value,work) {
      if (value.state!==state || value.cookie!==`${state}.${browser}` || value.operationHash!==pending || !pending) {
        throw new PlatformIdentityError('PLATFORM_MICROSOFT_OPERATION_REJECTED');
      }
      const context=Object.freeze({});contexts.set(context,value.operationHash);
      let result;try { result=await work(context); } finally { contexts.delete(context); }
      if (failure) throw new Error('synthetic-commit-failure');pending=null;
      return { status: 'operation_completed',result,principal,setCookies: [normal,clearPlatformMicrosoftOperationCookie()] };
    },
    verifiedOperationPrincipal(context,hash) {
      assert.equal(contexts.get(context),hash);contexts.delete(context);
      return { ...principal,assurance: { ...principal.assurance,level: 'step_up',authenticationContext: 'cm:ms:fresh:v1' },
        session: { ...principal.session,id,stepUpExpiresAt: new Date(Date.now()+120000).toISOString() } };
    },
  };
  const handler=protectPlatformMicrosoftRoute(platformTenantRoutes,{ authService: auth,environment: 'int',securityEpoch: 7 })
    .createHandler({ maxBodyBytes: 32768,maxResponseBytes: 65536,platformPublicOrigin: origin,
      platformEntraAuthority: authority,platformEntraClientId: id,platformPrincipalGuard: { async require(_request,options) {
        if (!csrf && options.csrf) throw new PlatformIdentityError('PLATFORM_CSRF_INVALID');return current;
      } },platformTenantOperationsService: { async listDirectory() {},async revokeInvitation() {},async reissueInvitation() {},
        async transitionLifecycle() {},async createTenantInvitation(input) {
        assert.equal(input.operatorContext.assurance.level,'step_up');writes++;return { outcome: 'updated' };
      } },platformAuditService: { createDeniedEvent: value=>value,async record(value) {
        assert.equal(value.metadata.reasonCode,'microsoft_operation_rejected');denials++;
      } } });
  async function invoke({ proof,value=body,headers={},path='/api/v1/platform/tenants' }={}) {
    const bytes=Buffer.from(JSON.stringify(value)),request=Readable.from([bytes]);request.method='POST';
    request.headers={ 'content-type': 'application/json','content-length': String(bytes.length),
      cookie: `cm_platform_session=synthetic; ${cookies[1].split(';')[0]}`,'idempotency-key': id,
      ...(proof===undefined ? {} : { 'x-platform-microsoft-proof': proof }),...headers };
    const response={ statusCode: 200,headers: {},setHeader(name,value) { this.headers[name.toLowerCase()]=value; },
      end(value) { this.payload=JSON.parse(value); } };
    try { await handler({ request,response,parsedUrl: new URL(path,origin),path,requestId: session }); }
    catch (error) { response.error=error; }return response;
  }
  return { invoke,writes: ()=>writes,denials: ()=>denials,csrf: value=>{ csrf=value; },
    current: value=>{ current=value; },fail: ()=>{ failure=true; } };
}
test('Microsoft protects the actual Tenant route and returns only a normal session after exact committed execution',async()=>{
  const f=fixture(),first=await f.invoke();assert.equal(first.statusCode,428);assert.equal(f.writes(),0);
  assert.equal(first.payload.status,'microsoft_required');assert.deepEqual(first.headers['set-cookie'],cookies);
  assert.equal(first.payload.options,undefined);
  assert.equal(new URL(first.payload.authorizationUrl).origin,'https://login.microsoftonline.com');
  assert.equal(new URL(first.payload.authorizationUrl).searchParams.get('prompt'),'login');
  const done=await f.invoke({ proof: state });assert.equal(done.statusCode,201);assert.equal(f.writes(),1);
  assert.deepEqual(done.headers['set-cookie'],[normal,clearPlatformMicrosoftOperationCookie()]);
  assert.equal((await f.invoke({ proof: state })).error.statusCode,403);assert.equal(f.writes(),1);
});
test('Microsoft exact operation rejects body/idempotency/cookie/context swaps and app-passkey proof substitution',async()=>{
  const f=fixture();await f.invoke();
  for (const change of [{ value: { ...body,displayName: 'Other' } },{ headers: { 'idempotency-key': session } },
    { headers: { cookie: 'cm_platform_session=synthetic' } },{ headers: { 'x-platform-passkey-proof': state } },
    { proof: [state] },{ proof: state+'=' }]) {
    const result=await f.invoke({ proof: state,...change });assert.ok(result.error);assert.equal(result.payload,undefined);
  }
  assert.equal(f.writes(),0);assert.ok(f.denials()>=3);
  f.current({ ...principal,assurance: { ...principal.assurance,authenticationContext: 'cm:pk:v1' } });
  assert.equal((await f.invoke()).error.statusCode,403);
});
test('Microsoft transport preserves CSRF, original body validation and withheld result on commit failure',async()=>{
  const f=fixture();f.csrf(false);assert.ok((await f.invoke()).error);f.csrf(true);
  const invalid={ ...body,roles: ['platform_security_admin'] };
  await f.invoke({ value: invalid });assert.equal((await f.invoke({ value: invalid,proof: state })).error.statusCode,400);
  assert.equal(f.writes(),0);await f.invoke();f.fail();const failed=await f.invoke({ proof: state });
  assert.match(failed.error.message,/synthetic-commit-failure/);assert.equal(failed.payload,undefined);
  assert.equal(failed.headers['set-cookie'],undefined);
});
