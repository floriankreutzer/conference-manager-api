import { randomUUID } from 'node:crypto';
import { PLATFORM_ENTRA_PROVIDER } from '../../src/domain/identity-provider.js';
import { permissionsForPlatformRoles } from '../../src/platform/identity/policy.js';
import { createProtectedPlatformSessions } from '../../src/platform/identity/protected-platform-sessions.js';
import { createPlatformPasskeyVerifier } from '../../src/platform/identity/passkey-verifier.js';
import { createPlatformPasskeyAuthService } from '../../src/platform/identity/passkey-auth-service.js';
import { readPlatformPasskeyTransactionCookie } from '../../src/platform/identity/passkey-auth-cookie.js';
import { createPostgresPlatformSessionRepository } from '../../src/persistence/postgres/platform-session-repository.js';
import { createPostgresPlatformPasskeyAuthRepository } from '../../src/persistence/postgres/platform-passkey-auth-repository.js';
import { createPostgresPlatformAuditRepository } from '../../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { platformPasskeyFixture } from '../../tests/support/platform-passkey-fixture.js';

// No network or live identity grant. Synthetic Microsoft-shaped operator custody
// and two actual software P256 keys exercise the pinned verifier and repositories.
export async function createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch }={}) {
  const operatorId=randomUUID(),roles=['platform_tenant_operator'];
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,scope_mode,roles)
    VALUES($1::uuid,$2,'synthetic-directory',$1::text,'allowlist',$3)`,[operatorId,PLATFORM_ENTRA_PROVIDER,roles]);
  const keys=[platformPasskeyFixture({ operatorId }),platformPasskeyFixture({ operatorId })];
  for (const key of keys) await pool.query(`INSERT INTO platform_passkey_credentials
    (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
    VALUES($1,$2,'int',$3,$4,$5,0,false,false)`,
  [randomUUID(),operatorId,key.credential.id,key.credential.publicKey,key.userHandle]);
  const auditRepository=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const sessions=createProtectedPlatformSessions({ repository: createPostgresPlatformSessionRepository(pool,{ auditRepository }),
    environment: 'int',protectedSecurityEpoch: epoch,publicOrigin: 'https://ops-int.example.com',
    csrfSecret: 'c'.repeat(48),securityEpoch: 7 });
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment: 'int',securityEpoch: epoch });
  const verifier=createPlatformPasskeyVerifier({ publicOrigin: 'https://ops-int.example.com',environment: 'int' });
  const auth=createPlatformPasskeyAuthService({ environment: 'int',securityEpoch: 7,transactionSecret: 'p'.repeat(48),
    minimumCredentialCount: 2,verifier,sessionService: sessions,
    repository: createPostgresPlatformPasskeyAuthRepository(pool,{ auditRepository,verifier,
      stepUpTransaction: scopes.withSyntheticExclusive }),
    primaryOperatorService: { resolve() { throw new Error('PRIMARY_NOT_USED_BY_SYNTHETIC_FIXTURE'); } } });
  let current,counter=0;
  async function freshSession() {
    const row=(await pool.query('SELECT security_version FROM platform_operators WHERE id=$1',[operatorId])).rows[0];
    const securityVersion=Number(row.security_version);
    current=await sessions.issue({ operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion,
      targetScope: { mode: 'allowlist',securityVersion },providerIdentity: { provider: PLATFORM_ENTRA_PROVIDER,
        tenantReference: 'synthetic-directory',subjectReference: operatorId },
      assurance: { level: 'mfa',authenticationContext: 'cm:pk:v1',authenticatedAt: new Date().toISOString() } });
  }
  await freshSession();
  return { operatorId,keys,auth,sessions,scopes,auditRepository,freshSession,current: ()=>current,
    async execute(operationHash,mutation) {
      const start=await scopes.withShared(()=>auth.startStepUp(current.principal,{ operationHash }));
      counter++;
      const result=await auth.executeStepUp({ operationHash,state: start.state,
        cookie: readPlatformPasskeyTransactionCookie({ cookie: start.setCookie.split(';')[0] }),
        response: keys[0].response('get',{ counter,client: { challenge: start.options.challenge } }),
        request: { headers: { cookie: current.setCookie.split(';')[0] } },
      },mutation);
      current={ principal: result.principal,setCookie: result.setCookies[0],csrfToken: result.csrfToken };
      return result.result;
    },
  };
}
