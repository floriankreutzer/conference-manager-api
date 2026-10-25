import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createPlatformHttpServer } from '../../src/platform/server.js';
import { createPlatformLogger } from '../../src/platform/http/observability.js';
import { permissionsForPlatformRoles } from '../../src/platform/identity/policy.js';
import { readPlatformSessionToken,serializePlatformSessionCookie } from '../../src/platform/identity/session-cookie.js';
import { serializePlatformPasskeyTransactionCookie,clearPlatformPasskeyTransactionCookie }
  from '../../src/platform/identity/passkey-auth-cookie.js';
import { createPlatformSyntheticHandoffIntentCookie } from '../../src/platform/identity/synthetic-handoff-intent-cookie.js';
import { createPlatformSyntheticHandoffRouteModule } from '../../src/platform/http/synthetic-handoff-routes.js';

import { PLATFORM_ROLE } from '../../src/platform/identity/policy.js';
import { createPlatformOwnerCustomerIntentCookie } from '../../src/platform/identity/owner-customer-intent-cookie.js';
import { createPlatformOwnerCustomerHandoffRouteModule } from '../../src/platform/http/owner-customer-handoff-routes.js';
import { serializePlatformMicrosoftOperationBrowserCookie,serializePlatformMicrosoftOperationCookie,
  clearPlatformMicrosoftOperationCookie } from '../../src/platform/identity/microsoft-operation-cookie.js';

const ORIGIN='https://localhost',STATE=Buffer.alloc(32,1).toString('base64url');
const NONCE=Buffer.alloc(32,2).toString('base64url'),CSRF=Buffer.alloc(32,3).toString('base64url');
const PASSKEY_STATE=Buffer.alloc(32,5).toString('base64url');
export async function platformHandoffHttpFixture(t,{ injected=true,kind='synthetic' }={}) {
  const legacy=kind==='synthetic',ROOT=legacy ? '/api/v1/platform/auth/delegation' : '/api/v1/platform/auth/owner';
  const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
    customerOrigin: 'https://127.0.0.1',platformOrigin: ORIGIN },operatorId=randomUUID(),flowId=randomUUID();
  const roles=legacy ? ['platform_tenant_operator'] : Object.values(PLATFORM_ROLE).sort(),now=new Date().toISOString();
  const sessionId=randomUUID(),generationId=randomUUID();
  const principal={ operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 3,
    providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: legacy ? 'directory' : randomUUID(),
      subjectReference: legacy ? 'subject' : randomUUID() },
    targetScope: { mode: legacy ? 'allowlist' : 'all',securityVersion: 3 },
    assurance: { level: 'mfa',authenticationContext: legacy ? 'cm:pk:v1' : 'cm:ms:mfa:v1',authenticatedAt: now },
    session: { id: sessionId,issuedAt: now,expiresAt: new Date(Date.now()+3_600_000).toISOString(),securityVersion: 3,
      securityEpoch: 7,stepUpExpiresAt: null } };
  const token=Buffer.alloc(32,4).toString('base64url');
  const normalCookie=serializePlatformSessionCookie(token,{ secure: true,maxAgeSeconds: 3600 });
  const cookieCodec=(legacy ? createPlatformSyntheticHandoffIntentCookie : createPlatformOwnerCustomerIntentCookie)(
    { scope,secret: 'i'.repeat(48) });
  const intentCookie=cookieCodec.issue({ flowId,state: STATE }).split(';')[0],calls=[],logs=[];
  const authorizationUrl=new URL(`https://login.microsoftonline.com/${operatorId}/oauth2/v2.0/authorize`);
  for (const [key,value] of Object.entries({ client_id: sessionId,
    redirect_uri: ORIGIN+'/api/v1/platform/auth/microsoft/operation/callback',scope: 'openid profile',response_type: 'code',
    response_mode: 'query',max_age: '0',state: PASSKEY_STATE,nonce: NONCE,code_challenge: NONCE,code_challenge_method: 'S256',
    claims: JSON.stringify({ id_token: { auth_time: { essential: true },amr: { essential: true } } }) })) {
    authorizationUrl.searchParams.set(key,value);
  }
  const state={ current: principal,block: null,entered: null,
    directory: { tenants: [{ tenantId: generationId,displayName: 'Own REAL target',status: 'active' }],nextTenantId: null },
    options: legacy ? { status: 'passkey_required',state: PASSKEY_STATE,options: { challenge: NONCE,userVerification: 'required' },
      setCookie: serializePlatformPasskeyTransactionCookie(`${PASSKEY_STATE}.${NONCE}`) }
      : { status: 'microsoft_required',state: PASSKEY_STATE,authorizationUrl: authorizationUrl.href,
        setCookies: [serializePlatformMicrosoftOperationBrowserCookie(`${PASSKEY_STATE}.${NONCE}`),
          serializePlatformMicrosoftOperationCookie(`${PASSKEY_STATE}.${NONCE}`,120)] },
    approve: { status: 'operation_completed',principal: { ...principal,session: { ...principal.session,id: randomUUID() } },
      csrfToken: CSRF,setCookies: [normalCookie,legacy ? clearPlatformPasskeyTransactionCookie() : clearPlatformMicrosoftOperationCookie()],
      result: { status: 'redirect',
        location: `${scope.customerOrigin}/api/v1/auth/${legacy ? 'delegation' : 'owner'}/callback?state=${STATE}&code=${NONCE}` } } };
  const protocol=Object.fromEntries(['options','approve'].map(name=>[name,async input=>{
    if (!legacy && Object.hasOwn(input,'response')) throw new Error('OWNER_PROTOCOL_RESPONSE_FORBIDDEN');
    calls.push({ name,input });if (name==='approve' && state.block) { state.entered();await state.block; }
    if (state[name] instanceof Error) throw state[name];return state[name];
  }]));
  const module=(legacy ? createPlatformSyntheticHandoffRouteModule : createPlatformOwnerCustomerHandoffRouteModule)({
    protocol,intentCookie: cookieCodec,scope,directory: { async list(input) {
      calls.push({ name: 'directory',input });if (state.directory instanceof Error) throw state.directory;return state.directory;
    } } });
  const config={ mode: 'test',serviceVersion: '0.1.0',buildId: 'test-build',publicOrigin: ORIGIN,
    entraAuthority: `https://login.microsoftonline.com/${operatorId}`,entraClientId: sessionId,
    entraRedirectUri: `${ORIGIN}/api/v1/platform/auth/microsoft/callback`,mfaAuthenticationContext: 'c1',
    stepUpAuthenticationContext: 'c2',authenticationMaxAgeSeconds: 900,maxBodyBytes: 32768,maxResponseBytes: 65536,
    rateLimitMax: 1000,rateLimitWindowMs: 60000,rateLimitMaxKeys: 100,requestTimeoutMs: 5000,headersTimeoutMs: 5000,
    keepAliveTimeoutMs: 1000 };
  const server=createPlatformHttpServer({ config,routeModules: injected ? [module] : [],
    logger: createPlatformLogger({ write: v=>logs.push(v) }),
    platformSessionService: { resolvePrincipal: async request=>readPlatformSessionToken(request.headers)===token ? state.current : null,
      verifyCsrf: async request=>request.headers['x-csrf-token']===CSRF },
    platformAuditService: { createUnmappedAuthenticationFailure: value=>value,createDeniedEvent: value=>value,async record() {} } });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{ cookieCodec.destroy();await new Promise(resolve=>server.close(resolve)); });
  async function request(path,{ method='GET',body,headers={} }={}) {
    const raw=body===undefined ? null : typeof body==='string' ? body : JSON.stringify(body);
    return new Promise((resolve,reject)=>{
      const req=http.request({ hostname: '127.0.0.1',port: server.address().port,path: ROOT+path,method,
        headers: Object.fromEntries(Object.entries({ host: 'localhost',...(method==='POST' ? { origin: ORIGIN } : {}),
          ...(raw===null ? {} : { 'content-type': 'application/json','content-length': Buffer.byteLength(raw) }),...headers })
          .filter(([,value])=>value!==undefined)) },res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({ status: res.statusCode,
          headers: res.headers,text: Buffer.concat(chunks).toString('utf8') }));
      });req.on('error',reject);if (raw) req.write(raw);req.end();
    });
  }
  const managed={ cookie: `${normalCookie.split(';')[0]}; ${intentCookie}`,'x-csrf-token': CSRF,'sec-fetch-site': 'same-origin' };
  return { request,state,calls,logs,flowId,generationId,principal,normalCookie,intentCookie,managed,scope,
    STATE,NONCE,CSRF,operationState: PASSKEY_STATE };
}
