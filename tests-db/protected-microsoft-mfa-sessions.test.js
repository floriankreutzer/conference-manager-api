import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformSessionRepository } from '../src/persistence/postgres/platform-session-repository.js';
import { createProtectedPlatformSessions } from '../src/platform/identity/protected-platform-sessions.js';
import { PLATFORM_ROLE, permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { createProtectedPlatformAuthentication } from '../src/platform-production-authentication.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

// Explicit internal session seeding tests real custody and namespace fencing,
// not an actual Microsoft authentication or a live owner role assignment.
test('native Microsoft-MFA sessions require no keys and retain CSRF, old-mode, operator-version and epoch denial',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(()=>Promise.all([pool.end(),leasePool.end()]));await migrateUp(pool);
  const epoch=randomUUID(),operatorId=randomUUID(),directory=randomUUID(),subject=randomUUID();
  const roles=Object.values(PLATFORM_ROLE).sort();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  await pool.query(`INSERT INTO platform_operators
    (id,provider,provider_tenant_reference,provider_subject_reference,scope_mode,roles)
    VALUES($1,'microsoft_entra_platform',$2,$3,'all',$4::text[])`,[operatorId,directory,subject,roles]);
  const env={ NODE_ENV: 'pilot',DEPLOYMENT_ENVIRONMENT: 'int',PLATFORM_PUBLIC_ORIGIN: 'https://ops-int.example.com',
    PLATFORM_SERVICE_VERSION: '0.1.0',PLATFORM_BUILD_ID: 'microsoft-mfa-fixture',
    PLATFORM_ENTRA_TENANT_ID: directory,PLATFORM_ENTRA_CLIENT_ID: randomUUID(),
    PLATFORM_ENTRA_CLIENT_SECRET: 'e'.repeat(48),PLATFORM_ENTRA_AUTHORITY: `https://login.microsoftonline.com/${directory}`,
    PLATFORM_OIDC_TRANSACTION_SECRET: 'o'.repeat(48),PLATFORM_CSRF_SECRET: 'c'.repeat(48),
    PLATFORM_AUDIT_HMAC_SECRET: 'a'.repeat(48),PLATFORM_CURSOR_SECRET: 'u'.repeat(48),
    PLATFORM_TENANT_AUDIT_HMAC_SECRET: 't'.repeat(48),PLATFORM_ASSURANCE_MODE: 'microsoft_mfa',
    PLATFORM_SECURITY_EPOCH: '7',PLATFORM_DATABASE_URL: database.databaseUrl,PLATFORM_DATABASE_SSL: 'verify-full',
    PLATFORM_AUTHENTICATION_MAX_AGE_SECONDS: '300',PLATFORM_OIDC_TRANSACTION_TTL_SECONDS: '300' };
  const owned=createProtectedPlatformAuthentication({ env,pool,leasePool,protectedSecurityEpoch: epoch });
  assert.equal(owned.platformPasskeyService,undefined);
  const auditRepository=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const sessions=createProtectedPlatformSessions({ environment: 'int',protectedSecurityEpoch: epoch,
    repository: createPostgresPlatformSessionRepository(pool,{ auditRepository }),publicOrigin: env.PLATFORM_PUBLIC_ORIGIN,
    csrfSecret: env.PLATFORM_CSRF_SECRET,securityEpoch: 7,authenticationMaxAgeSeconds: 300 });
  const identity=context=>({ operatorId,providerIdentity: { provider: 'microsoft_entra_platform',
    tenantReference: directory,subjectReference: subject },roles,permissions: permissionsForPlatformRoles(roles),
    securityVersion: 1,targetScope: { mode: 'all',securityVersion: 1 },assurance: {
      level: context==='cm:ms:fresh:v1' ? 'step_up' : 'mfa',authenticationContext: context,
      authenticatedAt: new Date().toISOString() } });
  const issue=context=>owned.withPreparationScope(()=>sessions.issue(identity(context),{ correlationId: randomUUID() }));
  const request=issued=>({ headers: { cookie: issued.setCookie.split(';')[0],'x-csrf-token': issued.csrfToken } });
  const issued=await issue('cm:ms:mfa:v1'),current=await owned.platformHttpSessionService.resolvePrincipal(request(issued));
  assert.deepEqual(current.roles,roles);
  assert.equal(await owned.platformHttpSessionService.verifyCsrf(request(issued),current),true);
  assert.equal(await owned.platformHttpSessionService.verifyCsrf({ headers: { 'x-csrf-token': 'x'.repeat(43) } },current),false);
  const old=await issue('cm:pk:v1');
  assert.equal(await owned.platformHttpSessionService.resolvePrincipal(request(old)),null);
  const fresh=await issue('cm:ms:fresh:v1');
  assert.equal((await owned.platformHttpSessionService.resolvePrincipal(request(fresh))).assurance.level,'step_up');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_passkey_credentials')).rows[0].count,0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_passkey_auth_transactions')).rows[0].count,0);
  await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[operatorId]);
  assert.equal(await owned.platformHttpSessionService.resolvePrincipal(request(issued)),null);
  const nextEpoch=randomUUID();
  await pool.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,revision=revision+1,
    updated_at=clock_timestamp() WHERE environment='int'`,[nextEpoch]);
  await assert.rejects(owned.platformHttpSessionService.resolvePrincipal(request(issued)),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  const next=createProtectedPlatformAuthentication({ env,pool,leasePool,protectedSecurityEpoch: nextEpoch });
  assert.equal(await next.platformHttpSessionService.resolvePrincipal(request(issued)),null);
  assert.ok((await pool.query("SELECT count(*)::int AS count FROM platform_audit_events WHERE action='platform.session.issued'"))
    .rows[0].count>=3);
});
