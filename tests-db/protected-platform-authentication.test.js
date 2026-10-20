import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createPostgresProtectedPlatformPasskeyAuthRepository }
  from '../src/persistence/postgres/platform-protected-passkey-auth-repository.js';
import { createPostgresPlatformOidcTransactionRepository } from '../src/persistence/postgres/platform-oidc-transaction-repository.js';
import { createPlatformEntraPrimaryAuthService } from '../src/platform/identity/entra-auth-service.js';
import { createPlatformPasskeyAuthService } from '../src/platform/identity/passkey-auth-service.js';
import { createPlatformPasskeyVerifier } from '../src/platform/identity/passkey-verifier.js';
import { deriveProtectedAuthenticationFlowSecret } from '../src/identity/protected-authentication-flow-secret.js';
import { createProtectedPlatformAuthentication } from '../src/platform-production-authentication.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

// Internal fixture primary custody is explicit. Actual P256 proofs/repositories
// run here; this is not real Microsoft, physical-device or deployment acceptance.
test('native owned Platform auth admits actual signed login and fences pending passkey/OAuth and sessions across UUID rotation',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const epoch=randomUUID(),nextEpoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const owner=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
  const directory='11111111-1111-4111-8111-111111111111';
  const env={ NODE_ENV: 'pilot',DEPLOYMENT_ENVIRONMENT: 'int',PLATFORM_PUBLIC_ORIGIN: 'https://ops-int.example.com',
    PLATFORM_SERVICE_VERSION: '0.1.0',PLATFORM_BUILD_ID: 'protected-auth-fixture',
    PLATFORM_ENTRA_TENANT_ID: directory,PLATFORM_ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    PLATFORM_ENTRA_CLIENT_SECRET: 'e'.repeat(48),PLATFORM_ENTRA_AUTHORITY: `https://login.microsoftonline.com/${directory}`,
    PLATFORM_OIDC_TRANSACTION_SECRET: 'o'.repeat(48),PLATFORM_CSRF_SECRET: 'c'.repeat(48),
    PLATFORM_AUDIT_HMAC_SECRET: 'a'.repeat(48),PLATFORM_CURSOR_SECRET: 'u'.repeat(48),
    PLATFORM_TENANT_AUDIT_HMAC_SECRET: 't'.repeat(48),PLATFORM_PASSKEY_TRANSACTION_SECRET: 'p'.repeat(48),
    PLATFORM_ASSURANCE_MODE: 'application_passkey',PLATFORM_SECURITY_EPOCH: '7',PLATFORM_DATABASE_URL: database.databaseUrl,
    PLATFORM_DATABASE_SSL: 'verify-full' };
  const owned=createProtectedPlatformAuthentication({ env,pool,leasePool,protectedSecurityEpoch: epoch });
  const verifier=createPlatformPasskeyVerifier({ publicOrigin: env.PLATFORM_PUBLIC_ORIGIN,environment: 'int' });
  const seeder=createPlatformPasskeyAuthService({ environment: 'int',securityEpoch: 7,verifier,sessionService: owner.sessions,
    minimumCredentialCount: 2,transactionSecret: deriveProtectedAuthenticationFlowSecret({ ...scope,secret: 'p'.repeat(48),
      purpose: 'platform-passkey-flow' }),repository: createPostgresProtectedPlatformPasskeyAuthRepository(pool,
      { ...scope,verifier,auditRepository: owner.auditRepository }),primaryOperatorService: { async resolve(value) {
      assert.equal(value,'synthetic-verified-primary');return { operatorId: owner.operatorId,
        securityVersion: owner.current().principal.securityVersion,primaryAuthenticatedAt: new Date().toISOString() };
    } } });
  const start=()=>owner.scopes.withShared(()=>seeder.startLogin('synthetic-verified-primary'));
  const started=await start(),cookie=started.setCookie.split(';')[0].split('=')[1];
  assert.equal((await owned.platformPasskeyService.pendingAuthentication(cookie)).status,'passkey_required');
  const issued=await owned.platformPasskeyService.authenticate({ cookie,state: started.state,
    response: owner.keys[0].response('get',{ counter: 1,client: { challenge: started.options.challenge } }) });
  assert.equal(issued.status,'authenticated');assert.equal(issued.principal.assurance.level,'mfa');
  const request={ headers: { cookie: issued.setCookies[0].split(';')[0] } };
  assert.ok(await owned.platformHttpSessionService.resolvePrincipal(request));
  await owned.withPreparationScope(()=>withPostgresTransaction(pool,async()=>{
    assert.ok(await owned.platformHttpSessionService.resolvePrincipal(request));
  },{ isolationLevel: 'REPEATABLE READ' }));
  const pending=await start(),pendingCookie=pending.setCookie.split(';')[0].split('=')[1];
  let oauthInput,redemptions=0;
  const oidc=createPlatformEntraPrimaryAuthService({ repository: createPostgresPlatformOidcTransactionRepository(pool),
    publicOrigin: env.PLATFORM_PUBLIC_ORIGIN,securityEpoch: 7,auditService: owned.platformAuditService,
    transactionSecret: deriveProtectedAuthenticationFlowSecret({ ...scope,secret: 'o'.repeat(48),purpose: 'platform-microsoft-flow' }),
    passkeyAuthService: { startLogin: ()=>assert.fail('PRIMARY_CANNOT_GRANT') },entraClient: {
      authorizationUrl(input) { oauthInput=input;return 'https://login.microsoftonline.com/fixture'; },
      redeemAuthorizationCode() { redemptions++;assert.fail('NO_REAL_PROVIDER_REDEMPTION'); },
      verifyPrimary() { assert.fail('NO_PRIMARY'); },
    } });
  const oauth=await owner.scopes.withShared(()=>oidc.start()),browserBinding=oauth.setCookie.split(';')[0].split('=')[1];
  const counts=async()=>(await pool.query(`SELECT
    (SELECT count(*)::int FROM platform_sessions) AS sessions,
    (SELECT count(*)::int FROM platform_passkey_auth_transactions WHERE consumed_at IS NOT NULL) AS consumed,
    (SELECT count(*)::int FROM platform_oidc_auth_transactions) AS oauth_pending`)).rows[0];
  const before=await counts();
  await assert.rejects(owned.normalPasskeyService.startLogin({ status: 'primary_verified',claims: { tid: directory } }),
    /PLATFORM_PRIMARY_ASSERTION_NOT_VERIFIED/);
  assert.deepEqual(await counts(),before);
  await pool.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,revision=revision+1,
    updated_at=clock_timestamp() WHERE environment='int'`,[nextEpoch]);
  const next=createProtectedPlatformAuthentication({ env,pool,leasePool,protectedSecurityEpoch: nextEpoch });
  await assert.rejects(owned.platformPasskeyService.pendingAuthentication(pendingCookie),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  await assert.rejects(next.platformPasskeyService.pendingAuthentication(pendingCookie),/PLATFORM_PASSKEY_AUTHENTICATION_REJECTED/);
  assert.equal(await next.platformHttpSessionService.resolvePrincipal(request),null);
  await assert.rejects(next.complete({ request: { headers: {} },state: oauthInput.state,code: 'synthetic-code',browserBinding,
    correlationId: randomUUID() }),/PLATFORM_OIDC_BROWSER_BINDING_INVALID/);
  assert.equal(redemptions,0);assert.deepEqual(await counts(),before);
  const events=await owner.auditRepository.listVerified({ scope: { operatorId: owner.operatorId,
    securityVersion: owner.current().principal.securityVersion,mode: 'allowlist' },limit: 50 });
  assert.ok(events.some(event=>event.action==='platform.session.issued'));
});
