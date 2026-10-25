import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';

const SURFACES=Object.freeze({ customer: 'app-int.example.test',platform: 'ops-int.example.com' });
function surface(value) { if (!Object.hasOwn(SURFACES,value)) throw new Error('FIXTURE_SURFACE_INVALID');return SURFACES[value]; }
export async function unusedProtectedRuntimePort() {
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
export function startProtectedRuntimeProcess(selected,environment) {
  surface(selected);return start(selected,environment,new URL(`./protected-${selected}-runtime-child.mjs`,import.meta.url));
}
export function startProtectedOwnerBrowserPlatformProcess(environment) {
  return start('platform',environment,new URL('./protected-owner-browser-platform-child.mjs',import.meta.url));
}
async function start(selected,environment,entry) {
  surface(selected);
  const child=fork(entry,[],{
    cwd: new URL('../../',import.meta.url),execArgv: [],env: environment,stdio: ['ignore','pipe','pipe','ipc'] });let logs='';
  for (const output of [child.stdout,child.stderr]) output.on('data',chunk=>{
    if (logs.length+chunk.length>65536) { child.kill();return; }logs+=chunk.toString('utf8');
  });
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({ code,signal })));
  const outcome=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{ child.kill();reject(new Error('PROTECTED_CHILD_START_TIMEOUT')); },15000);
    child.once('error',()=>{ clearTimeout(timeout);reject(new Error('PROTECTED_CHILD_FAILED')); });
    child.once('message',message=>{ clearTimeout(timeout);resolve(message); });
    exited.then(()=>{ clearTimeout(timeout);resolve({ type: 'exited' }); });
  });
  return { outcome,logs: ()=>logs,async stop() {
    let timeout;
    try {
      if (child.connected) child.send('stop');
      return await Promise.race([exited,new Promise((_,reject)=>{
        timeout=setTimeout(()=>{ child.kill('SIGKILL');reject(new Error('PROTECTED_CHILD_STOP_TIMEOUT')); },12000);
      })]);
    } finally { clearTimeout(timeout); }
  } };
}
export function exchangeProtectedRuntime(selected,port,path,{ method='GET',body,form,headers={} }={}) {
  const host=surface(selected),raw=form===undefined ? body===undefined ? '' : JSON.stringify(body)
    : new URLSearchParams(form).toString();
  const requestHeaders={ host,origin:`https://${host}`,'sec-fetch-site':'same-origin',
    ...(body===undefined && form===undefined ? {} : {
      'content-type': form===undefined ? 'application/json' : 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(raw) }) };
  for (const [name,value] of Object.entries(headers)) {
    if (value===null) delete requestHeaders[name];else requestHeaders[name]=value;
  }
  return new Promise((resolve,reject)=>{
    const call=request({ hostname: '127.0.0.1',port,path,method,headers: requestHeaders },response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>{ text+=chunk; });
      response.once('end',()=>resolve({ status: response.statusCode,headers: response.headers,text }));
    });call.once('error',reject);call.setTimeout(10000,()=>call.destroy(new Error('FIXTURE_HTTP_TIMEOUT')));call.end(raw);
  });
}
