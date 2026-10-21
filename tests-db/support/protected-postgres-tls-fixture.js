import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp,readFile,writeFile,rm,chmod } from 'node:fs/promises';
import pg from 'pg';

// Same immutable image already loaded by the native CI service. Never pull,
// discover credentials, touch the shared service, or contact a cloud database.
const IMAGE='docker.io/library/postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
function command(program,args,options={}) {
  const result=spawnSync(program,args,{ encoding: 'utf8',timeout: 15000,maxBuffer: 65536,...options });
  if (result.status!==0 || result.error) throw new Error('PROTECTED_POSTGRES_TLS_FIXTURE_FAILED');
  return result.stdout.trim();
}
export async function createProtectedPostgresTlsFixture(t) {
  const base=new URL(process.env.DATABASE_URL ?? 'invalid:');
  if (!['localhost','127.0.0.1'].includes(base.hostname)
    || !/^\/conference_manager_test_\d+_\d+$/.test(base.pathname)) throw new Error('ISOLATED_DATABASE_FIXTURE_REQUIRED');
  command('docker',['image','inspect','--format','{{.Id}}',IMAGE]);
  const directory=await mkdtemp('/tmp/cm-protected-postgres-tls-');let container=null,destroyed=false;
  const destroy=async()=>{
    if (destroyed) return;destroyed=true;
    try { if (container) command('docker',['rm','--force','--volumes',container]); }
    finally { await rm(directory,{ recursive: true,force: true }); }
  };t.after(destroy);await chmod(directory,0o755);
  command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=fixture.invalid',
    '-addext','subjectAltName=IP:127.0.0.1','-keyout',`${directory}/server.key`,'-out',`${directory}/server.crt`]);
  const certificate=await readFile(`${directory}/server.crt`),password=randomBytes(32).toString('hex');
  await writeFile(`${directory}/fixture.env`,
    `POSTGRES_USER=conference_manager_fixture\nPOSTGRES_DB=conference_manager\nPOSTGRES_PASSWORD=${password}\n`
      +'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\n',{ mode: 0o600 });
  const id=command('docker',['run','--detach','--rm','--pull=never','--memory=512m','--cpus=1','--pids-limit=128',
    '--publish','127.0.0.1::5432','--env-file',`${directory}/fixture.env`,'--mount',`type=bind,source=${directory},target=/fixture`,
    IMAGE,'sh','-c','chown postgres:postgres /fixture/server.key; chmod 600 /fixture/server.key; '
      +'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/fixture/server.crt -c ssl_key_file=/fixture/server.key']);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('PROTECTED_POSTGRES_CONTAINER_INVALID');container=id;
  const mapped=command('docker',['port',container,'5432/tcp']);
  if (!/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(mapped)) throw new Error('PROTECTED_POSTGRES_LOOPBACK_REQUIRED');
  const url=new URL(`postgresql://${mapped}/conference_manager`);
  url.username='conference_manager_fixture';url.password=password;
  let ready=false;const deadline=Date.now()+15000;
  while (Date.now()<deadline) {
    const client=new pg.Client({ connectionString: url.href,ssl: { ca: certificate,rejectUnauthorized: true },
      connectionTimeoutMillis: 500,query_timeout: 1000 });
    try { await client.connect();await client.query('SELECT 1');ready=true;break; }
    catch { await new Promise(resolve=>setTimeout(resolve,100)); }
    finally { await client.end(); }
  }
  assert.equal(ready,true,'isolated PostgreSQL must start with actual verified TLS and SCRAM');
  function permissionFailures() {
    const logs=spawnSync('docker',['logs','--tail','300',container],{ encoding: 'utf8',timeout: 5000,maxBuffer: 65536 });
    // Only fixed PostgreSQL privilege metadata may reach a failing test log.
    // Never return SQL statements, parameters, provider payloads or raw errors.
    const text=`${logs.stdout ?? ''}\n${logs.stderr ?? ''}`;
    return [...new Set(text.split('\n').flatMap(line=>{
      const denied=line.match(/ERROR:  permission denied for (table|sequence|function|schema) ([a-z_][a-z0-9_]*)(?:$|\()/);
      return denied ? [`${denied[1]}:${denied[2]}`] : [];
    }))].slice(0,10);
  }
  return { url,certificate,caPath: `${directory}/server.crt`,password,destroy,permissionFailures };
}
