import { randomBytes,randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrateUp } from '../../scripts/db-migrations.mjs';
import { grantProtectedRuntimeRoles } from '../../scripts/support/protected-runtime-role-grants.mjs';
import { PLATFORM_ENTRA_PROVIDER } from '../../src/domain/identity-provider.js';
import { permissionsForPlatformRoles } from '../../src/platform/identity/policy.js';
import { createProtectedPlatformSessions } from '../../src/platform/identity/protected-platform-sessions.js';
import { createPostgresPlatformSessionRepository } from '../../src/persistence/postgres/platform-session-repository.js';
import { createPostgresPlatformAuditRepository } from '../../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresAuditRepository } from '../../src/persistence/postgres/audit-repository.js';
import { platformPasskeyFixture } from '../../tests/support/platform-passkey-fixture.js';
import { createProtectedPostgresTlsFixture } from './protected-postgres-tls-fixture.js';
import { unusedProtectedRuntimePort,startProtectedRuntimeProcess } from './protected-runtime-process-fixture.js';

export const PROTECTED_BROWSER_ORIGINS=Object.freeze({ customer: 'https://app-int.example.test',platform: 'https://ops-int.example.com' });

// Isolated test bootstrap, never imported by a production root or HTTP graph.
// Actual roots still construct every issuer/verifier/driver/provider themselves.
// Only the initial canonical MFA session/two software keys are fixture state;
// Microsoft primary, physical keys and operator recovery are not proved here.
export async function createProtectedBrowserRuntimeFixture(input) {
  if (!input || Object.keys(input).sort().join(',')!=='apiCommit,frontendCommit'
    || ![input.apiCommit,input.frontendCommit].every(value=>typeof value==='string' && /^[a-f0-9]{40}$/.test(value))) {
    throw new TypeError('PROTECTED_BROWSER_FIXTURE_REFS_REQUIRED');
  }
  const cleanups=[],children=[];let pool,closed=false;
  async function close() {
    if (closed) return;closed=true;let failed=false;
    for (const child of children.reverse()) try { await child.stop(); } catch { failed=true; }
    try { await pool?.end(); } catch { failed=true; }
    for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch { failed=true; }
    if (failed) throw new Error('PROTECTED_BROWSER_FIXTURE_CLEANUP_FAILED');
  }
  try {
    const database=await createProtectedPostgresTlsFixture({ after: cleanup=>cleanups.push(cleanup) });
    pool=new pg.Pool({ connectionString: database.url.href,ssl: { ca: database.certificate,rejectUnauthorized: true },
      max: 2,connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});
    await migrateUp(pool,fileURLToPath(new URL('../../migrations',import.meta.url)));
    const epoch=randomUUID(),roles=['cm_protected_int_customer','cm_protected_int_platform'];
    const passwords=roles.map(()=>randomBytes(32).toString('hex'));
    for (const [index,role] of roles.entries()) {
      if (!/^[a-f0-9]{64}$/.test(passwords[index])) throw new Error('PROTECTED_BROWSER_FIXTURE_PASSWORD_INVALID');
      await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${passwords[index]}'`);
    }
    await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
    // The unchanged operator installer resolves its immutable migration ledger
    // from its repository cwd. Only this sequential fixture bootstrap changes
    // cwd, before any browser or runtime child starts, and always restores it.
    const previousDirectory=process.cwd();
    try {
      process.chdir(fileURLToPath(new URL('../../',import.meta.url)));
      await grantProtectedRuntimeRoles(pool,{ environment: 'int',securityEpoch: epoch });
    } finally { process.chdir(previousDirectory); }
    const operatorId=randomUUID(),directoryId=randomUUID(),subjectId=randomUUID(),operatorRoles=['platform_tenant_operator'];
    await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,scope_mode,roles)
      VALUES($1,$2,$3,$4,'all',$5)`,[operatorId,PLATFORM_ENTRA_PROVIDER,directoryId,subjectId,operatorRoles]);
    const keys=[platformPasskeyFixture({ operatorId }),platformPasskeyFixture({ operatorId })];
    for (const key of keys) await pool.query(`INSERT INTO platform_passkey_credentials
      (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
      VALUES($1,$2,'int',$3,$4,$5,0,false,false)`,
    [randomUUID(),operatorId,key.credential.id,key.credential.publicKey,key.userHandle]);
    const securityVersion=Number((await pool.query('SELECT security_version FROM platform_operators WHERE id=$1',[operatorId]))
      .rows[0].security_version);
    const platformAudit=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
    const tenantAudit=createPostgresAuditRepository(pool,{ hmacSecret: 't'.repeat(48) });
    const sessions=createProtectedPlatformSessions({
      repository: createPostgresPlatformSessionRepository(pool,{ auditRepository: platformAudit }),
      environment: 'int',protectedSecurityEpoch: epoch,publicOrigin: PROTECTED_BROWSER_ORIGINS.platform,
      csrfSecret: 'c'.repeat(48),securityEpoch: 7,authenticationMaxAgeSeconds: 300 });
    const initial=await sessions.issue({ operatorId,roles: operatorRoles,permissions: permissionsForPlatformRoles(operatorRoles),
      securityVersion,targetScope: { mode: 'all',securityVersion },providerIdentity: { provider: PLATFORM_ENTRA_PROVIDER,
        tenantReference: directoryId,subjectReference: subjectId },
      assurance: { level: 'mfa',authenticationContext: 'cm:pk:v1',authenticatedAt: new Date().toISOString() } });
    const common={ NODE_ENV: 'production',NODE_EXTRA_CA_CERTS: database.caPath,PROTECTED_ENVIRONMENT: 'int',
      PROTECTED_SECURITY_EPOCH: epoch,PROTECTED_PLATFORM_SECURITY_EPOCH: '7',PROTECTED_API_COMMIT: input.apiCommit,
      PROTECTED_FRONTEND_COMMIT: input.frontendCommit,PROTECTED_SERVICE_VERSION: '1.0.0',
      PROTECTED_DATABASE_POOL_MAX: '1',PROTECTED_LEASE_POOL_MAX: '1',
      PROTECTED_CUSTOMER_ORIGIN: PROTECTED_BROWSER_ORIGINS.customer,PROTECTED_PLATFORM_ORIGIN: PROTECTED_BROWSER_ORIGINS.platform,
      PROTECTED_TENANT_AUDIT_HMAC_SECRET: 't'.repeat(48),PROTECTED_CUSTODY_LOOKUP_SECRET: 'l'.repeat(48),
      PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'initial',
      PROTECTED_CUSTODY_KEYRING: JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url') }]),
      PROTECTED_SYNTHETIC_ENABLED: 'true',PROTECTED_HANDOFF_SECRET: 'h'.repeat(48) };
    const customerClientId=randomUUID(),platformClientId=randomUUID();
    function connection(index) {
      const url=new URL(database.url);url.username=roles[index];url.password=passwords[index];return url.href;
    }
    const platform=await startProtectedRuntimeProcess('platform',{ ...common,PROTECTED_PLATFORM_DATABASE_URL: connection(1),
      PROTECTED_PEER_ENTRA_CLIENT_ID: customerClientId,PROTECTED_PLATFORM_ENTRA_CLIENT_ID: platformClientId,
      PROTECTED_PLATFORM_ENTRA_TENANT_ID: directoryId,PROTECTED_PLATFORM_ENTRA_CLIENT_SECRET: 'e'.repeat(48),
      PROTECTED_PLATFORM_OIDC_TRANSACTION_SECRET: 'o'.repeat(48),PROTECTED_PLATFORM_CSRF_SECRET: 'c'.repeat(48),
      PROTECTED_PLATFORM_AUDIT_HMAC_SECRET: 'a'.repeat(48),PROTECTED_PLATFORM_CURSOR_SECRET: 'u'.repeat(48),
      PROTECTED_PLATFORM_PASSKEY_TRANSACTION_SECRET: 'p'.repeat(48),PROTECTED_PLATFORM_OWNER_RECIPIENT: 'Owner@example.test',
      PROTECTED_PLATFORM_HOST: '127.0.0.1',PROTECTED_PLATFORM_PORT: String(await unusedProtectedRuntimePort()),
      PROTECTED_PLATFORM_ASSURANCE_MODE: 'application_passkey',PROTECTED_PLATFORM_HANDOFF_INTENT_SECRET: 'i'.repeat(48) });
    children.push(platform);if (platform.outcome.type!=='listening') throw new Error('PROTECTED_BROWSER_PLATFORM_NOT_READY');
    const customer=await startProtectedRuntimeProcess('customer',{ ...common,PROTECTED_CUSTOMER_DATABASE_URL: connection(0),
      PROTECTED_CUSTOMER_ENTRA_CLIENT_ID: customerClientId,PROTECTED_PEER_ENTRA_CLIENT_ID: platformClientId,
      PROTECTED_CUSTOMER_ENTRA_CLIENT_SECRET: 'g'.repeat(48),PROTECTED_CUSTOMER_CSRF_SECRET: 's'.repeat(48),
      PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET: 'f'.repeat(48),PROTECTED_CUSTOMER_EMAIL_CODE_SECRET: 'n'.repeat(48),
      PROTECTED_CUSTOMER_EMAIL_SOURCE_SECRET: 'b'.repeat(48),PROTECTED_CUSTOMER_MICROSOFT_FLOW_SECRET: 'm'.repeat(48),
      PROTECTED_CUSTOMER_HOST: '127.0.0.1',PROTECTED_CUSTOMER_PORT: String(await unusedProtectedRuntimePort()) });
    children.push(customer);if (customer.outcome.type!=='listening') throw new Error('PROTECTED_BROWSER_CUSTOMER_NOT_READY');
    return Object.freeze({ origins: PROTECTED_BROWSER_ORIGINS,keys,initialSetCookie: initial.setCookie,
      ports: Object.freeze({ customer: customer.outcome.port,platform: platform.outcome.port }),close,
      async evidence() {
        const rows=(await pool.query(`SELECT registry.slot,tenant.status,tenant.id,
          (SELECT count(*)::int FROM rooms WHERE tenant_id=tenant.id) AS rooms,
          (SELECT count(*)::int FROM synthetic_catalogue_media_assets WHERE tenant_id=tenant.id) AS media
          FROM tenant_runtime_registry registry JOIN tenants tenant ON tenant.id=registry.tenant_id
          WHERE registry.environment='int' AND registry.mode='synthetic' ORDER BY tenant.created_at,registry.slot`)).rows;
        for (const row of rows) if (await tenantAudit.verifyTenantChain(row.id)!==true) {
          throw new Error('PROTECTED_BROWSER_TENANT_AUDIT_INVALID');
        }
        const leaks=[database.password,...passwords,initial.setCookie.split(';')[0],'h'.repeat(48),'t'.repeat(48)];
        if (children.some(child=>leaks.some(secret=>child.logs().includes(secret)))) {
          throw new Error('PROTECTED_BROWSER_ROOT_LOG_REDACTION_FAILED');
        }
        return Object.freeze({ refs: { ...input },tenantChainsVerified: rows.length,
          tenants: rows.map(({ slot,status,rooms,media })=>({ slot,status,rooms,media })) });
      },
    });
  } catch {
    await close();throw new Error('PROTECTED_BROWSER_FIXTURE_SETUP_FAILED');
  }
}
