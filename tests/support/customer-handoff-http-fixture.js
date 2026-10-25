import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { createHttpServer } from '../../src/server.js';
import { createLogger } from '../../src/logger.js';
import { createSyntheticHandoffBrowserBinding } from '../../src/identity/synthetic-handoff-browser-binding.js';
import { createSyntheticCustomerHandoffRouteModule } from '../../src/http/synthetic-customer-handoff-routes.js';
import { serializeSyntheticHandoffBrowserCookie,serializeSyntheticHandoffCompletionCookie }
  from '../../src/identity/synthetic-handoff-cookie.js';
import { serializeSessionCookie,serializeClearedSessionCookie } from '../../src/identity/session-cookie.js';

import { createOwnerCustomerHandoffBrowserBinding } from '../../src/identity/owner-customer-handoff-browser-binding.js';
import { createOwnerCustomerHandoffRouteModule } from '../../src/http/owner-customer-handoff-routes.js';
import { serializeOwnerHandoffBrowserCookie,serializeOwnerHandoffCompletionCookie }
  from '../../src/identity/owner-customer-handoff-cookie.js';

const ORIGIN='https://127.0.0.1',NOW=Date.now();
export async function customerHandoffHttpFixture(t,{ injected=true,kind='synthetic' }={}) {
  const legacy=kind==='synthetic',ROOT=legacy ? '/api/v1/auth/delegation' : '/api/v1/auth/owner';
  const createBinding=legacy ? createSyntheticHandoffBrowserBinding : createOwnerCustomerHandoffBrowserBinding;
  const createRoutes=legacy ? createSyntheticCustomerHandoffRouteModule : createOwnerCustomerHandoffRouteModule;
  const serializeBrowser=legacy ? serializeSyntheticHandoffBrowserCookie : serializeOwnerHandoffBrowserCookie;
  const serializeCompletion=legacy ? serializeSyntheticHandoffCompletionCookie : serializeOwnerHandoffCompletionCookie;
  const tenantId=randomUUID();
  const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
    customerOrigin: ORIGIN,platformOrigin: 'https://localhost' };
  const binding=createBinding({ scope,secret: 'h'.repeat(48) }),flowId=randomUUID();
  const start=binding.issueStart(flowId),code=binding.issueCode(flowId);
  const signed=binding.issueCompletion({ binding: { flowId,browserVerifier: start.browserVerifier,codeVerifier: code.codeVerifier },
    browserToken: start.browserToken,now: new Date(NOW),expiresAt: new Date(NOW+30_000) });
  const originalCookie=serializeBrowser({ flowId,browserToken: start.browserToken }).split(';')[0];
  const completionCookie=serializeCompletion(signed.value).split(';')[0];
  const ordinaryCookie=serializeSessionCookie(Buffer.alloc(32,7).toString('base64url'),{ secure: true,maxAgeSeconds: 28800 });
  const state={ start: { status: 'started',flowId,state: start.state,browserToken: start.browserToken,
    expiresAt: new Date(NOW+600_000).toISOString() },
    callback: { status: 'confirmation',completion: signed.value,expiresAt: new Date(NOW+30_000).toISOString() },
    confirmation: { ...(legacy ? { slot: 'northwind' } : { tenantId,tenantName: 'Owner test Customer' }),
      role: 'employee',csrfToken: signed.csrfToken },
    complete: { principal: {},csrfToken: 'private-session-csrf',setCookie: ordinaryCookie },
    logout: { setCookie: serializeClearedSessionCookie({ secure: true }) },block: null,entered: null };
  const calls=[],logs=[];
  const service=Object.fromEntries(['start','callback','confirmation','complete','logout'].map(name=>[name,async input=>{
    calls.push({ name,input });
    if (name==='complete' && state.block) { state.entered();await state.block; }
    if (state[name] instanceof Error) throw state[name];return state[name];
  }]));
  const module=createRoutes({ service,scope,clock: ()=>NOW });
  const config=loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: ORIGIN,RATE_LIMIT_MAX: '120' });
  const server=createHttpServer({ config,logger: createLogger({ write: value=>logs.push(value) }),
    additionalRouteModules: injected ? [module] : [] });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{ binding.destroy();await new Promise(resolve=>server.close(resolve)); });
  async function request(path='/start',{ method='POST',body={},headers={} }={}) {
    const bytes=body===null ? null : Buffer.from(typeof body==='string' ? body : JSON.stringify(body));
    return new Promise((resolve,reject)=>{
      const req=http.request({ hostname: '127.0.0.1',port: server.address().port,path: ROOT+path,method,
        headers: Object.fromEntries(Object.entries({ host: '127.0.0.1',origin: ORIGIN,'sec-fetch-site': 'same-origin',
          ...(bytes===null ? {} : { 'content-type': 'application/json','content-length': bytes.length }),...headers })
          .filter(([,value])=>value!==undefined)) },response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
          const text=Buffer.concat(chunks).toString('utf8');resolve({ status: response.statusCode,headers: response.headers,text });
        });
      });req.on('error',reject);if (bytes) req.write(bytes);req.end();
    });
  }
  return { request,state,calls,logs,start,code,flowId,signed,originalCookie,completionCookie,ordinaryCookie,scope,tenantId };
}
