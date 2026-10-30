import { requirePlatformPasskeyMinimum } from './platform/identity/passkey-policy.js';
import { loadPlatformConfig } from './platform/config.js';
import { loadProtectedRuntimeProfile,protectedRuntimeConfigurationKeys } from './protected-runtime-config.js';
import { createProtectedCustodyCipher } from './protected-custody-configuration.js';
import { normalizeInvitationRecipient } from './domain/invitation-recipient.js';
import { isInternalUuid } from './domain/identifiers.js';
import { createProtectedPlatformAuthentication } from './platform-production-authentication.js';
import { APPROVED_OUTBOUND_ORIGINS } from './config.js';
import { loadProtectedPlatformInsightSnapshots } from './observability/platform-insight-snapshots.js';

const PREFIX='PROTECTED_PLATFORM_';
const KEYS=['ENTRA_TENANT_ID','ENTRA_CLIENT_ID','ENTRA_CLIENT_SECRET','OIDC_TRANSACTION_SECRET','CSRF_SECRET',
  'AUDIT_HMAC_SECRET','CURSOR_SECRET','PASSKEY_TRANSACTION_SECRET','ASSURANCE_MODE','OWNER_RECIPIENT','OWNER_LOCALE',
  'MINIMUM_PASSKEYS','SESSION_TTL_SECONDS','HOST','PORT','HANDOFF_INTENT_SECRET','OWNER_HANDOFF_INTENT_SECRET','AUDIT_SEGMENT_ID',
  'PROVIDER_USAGE_SNAPSHOT','PRODUCT_DELIVERY_SNAPSHOT','PRODUCT_RUNTIME_SNAPSHOT'];
const fail=code=>{ throw new TypeError(`PROTECTED_PLATFORM_CONFIG_${code}`); };
function read(env,key,optional=false) {
  if (optional && !Object.hasOwn(env,key)) return undefined;
  const own=Object.getOwnPropertyDescriptor(env,key);
  if (!own || !Object.hasOwn(own,'value') || typeof own.value!=='string' || !own.value
    || own.value!==own.value.trim() || /[\u0000-\u001f\u007f]/.test(own.value)) fail('VALUE_INVALID');return own.value;
}
function secret(env,key) {
  const value=read(env,key);if (Buffer.byteLength(value)<32 || Buffer.byteLength(value)>512) fail('SECRET_INVALID');return value;
}

// Full explicit Operations startup input. Compatibility names are confined to
// the immutable local canonical-validator input; inherited values are untouched.
export function loadProtectedPlatformConfiguration(env) {
  const profile=loadProtectedRuntimeProfile(env,{ surface: 'platform' });
  const allowed=new Set([...protectedRuntimeConfigurationKeys('platform'),...KEYS.map(key=>PREFIX+key)]);
  if (Reflect.ownKeys(env).some(key=>key.startsWith('PROTECTED_') && !allowed.has(key))) fail('UNKNOWN_KEY');
  const own=key=>read(env,PREFIX+key),optional=key=>read(env,PREFIX+key,true);
  const mode=own('ASSURANCE_MODE');
  if (!['passkey_setup','application_passkey','microsoft_mfa'].includes(mode)) fail('PASSKEY_PROFILE_REQUIRED');
  const microsoftMfa=mode==='microsoft_mfa';
  if (profile.syntheticParticipantsEnabled && !microsoftMfa) fail('PARTICIPANTS_MICROSOFT_REQUIRED');
  if (microsoftMfa && ['MINIMUM_PASSKEYS','PASSKEY_TRANSACTION_SECRET'].some(key=>Object.hasOwn(env,PREFIX+key))) {
    fail('MICROSOFT_MFA_PASSKEY_INPUT_FORBIDDEN');
  }
  const minimum=optional('MINIMUM_PASSKEYS') ?? '2';
  if (!['1','2'].includes(minimum)) fail('PASSKEY_MINIMUM_INVALID');
  const minimumCredentialCount=microsoftMfa ? null : requirePlatformPasskeyMinimum(profile.environment,Number(minimum));
  const segmentId=optional('AUDIT_SEGMENT_ID');
  if (segmentId!==undefined && (profile.environment!=='int' || !isInternalUuid(segmentId))) fail('AUDIT_SEGMENT_INVALID');
  const values={ entraClientSecret: secret(env,PREFIX+'ENTRA_CLIENT_SECRET'),
    oidcTransactionSecret: secret(env,PREFIX+'OIDC_TRANSACTION_SECRET'),
    csrfSecret: secret(env,PREFIX+'CSRF_SECRET'),auditHmacSecret: secret(env,PREFIX+'AUDIT_HMAC_SECRET'),
    cursorSecret: secret(env,PREFIX+'CURSOR_SECRET'),
    ...(!microsoftMfa ? { passkeyTransactionSecret: secret(env,PREFIX+'PASSKEY_TRANSACTION_SECRET') } : {}),
    tenantAuditHmacSecret: secret(env,'PROTECTED_TENANT_AUDIT_HMAC_SECRET'),lookupSecret: secret(env,'PROTECTED_CUSTODY_LOOKUP_SECRET') };
  if (profile.ownerCustomerAccessEnabled && !microsoftMfa) fail('OWNER_MICROSOFT_REQUIRED');
  const handoff=profile.syntheticEnabled ? secret(env,'PROTECTED_HANDOFF_SECRET') : null;
  const intent=profile.syntheticEnabled ? secret(env,PREFIX+'HANDOFF_INTENT_SECRET') : null;
  if (!profile.syntheticEnabled && (Object.hasOwn(env,'PROTECTED_HANDOFF_SECRET')
    || Object.hasOwn(env,PREFIX+'HANDOFF_INTENT_SECRET'))) fail('INACTIVE_HANDOFF_FORBIDDEN');
  if (profile.syntheticEnabled && !['application_passkey','microsoft_mfa'].includes(mode)) fail('SYNTHETIC_ACTIVE_PASSKEY_REQUIRED');
  const ownerHandoff=profile.ownerCustomerAccessEnabled ? secret(env,'PROTECTED_OWNER_HANDOFF_SECRET') : null;
  const ownerIntent=profile.ownerCustomerAccessEnabled ? secret(env,PREFIX+'OWNER_HANDOFF_INTENT_SECRET') : null;
  if (!profile.ownerCustomerAccessEnabled && (Object.hasOwn(env,'PROTECTED_OWNER_HANDOFF_SECRET')
    || Object.hasOwn(env,PREFIX+'OWNER_HANDOFF_INTENT_SECRET'))) fail('INACTIVE_OWNER_HANDOFF_FORBIDDEN');
  const material=[...Object.values(values),...(handoff===null ? [] : [handoff,intent]),
    ...(ownerHandoff===null ? [] : [ownerHandoff,ownerIntent])];
  if (new Set(material).size!==material.length
    || material.includes(decodeURIComponent(new URL(profile.database.databaseUrl).password))) fail('SECRET_ALIAS_FORBIDDEN');
  const clientId=own('ENTRA_CLIENT_ID'),tenantId=own('ENTRA_TENANT_ID'),peer=read(env,'PROTECTED_PEER_ENTRA_CLIENT_ID');
  if (![clientId,tenantId,peer].every(isInternalUuid) || peer.toLowerCase()===clientId.toLowerCase()) fail('IDENTITY_INVALID');
  const host=optional('HOST') ?? '0.0.0.0';if (!['0.0.0.0','127.0.0.1','::'].includes(host)) fail('HOST_INVALID');
  let ownerRecipient;try { ownerRecipient=normalizeInvitationRecipient(own('OWNER_RECIPIENT')); } catch { fail('OWNER_REQUIRED'); }
  const ownerLocale=optional('OWNER_LOCALE') ?? 'de';if (!['de','en'].includes(ownerLocale)) fail('OWNER_LOCALE_INVALID');
  if (optional('PRODUCT_RUNTIME_SNAPSHOT') !== undefined && profile.environment !== 'int') fail('INSIGHT_ENVIRONMENT_INVALID');
  const insightSources=loadProtectedPlatformInsightSnapshots({ providerSnapshot: optional('PROVIDER_USAGE_SNAPSHOT'),
    productSnapshot: optional('PRODUCT_DELIVERY_SNAPSHOT'),runtimeProductSnapshot: optional('PRODUCT_RUNTIME_SNAPSHOT'),
    securityEpoch: profile.securityEpoch,accessMode: microsoftMfa ? 'microsoft_mfa' : 'application_passkey' });
  const authenticationEnvironment=Object.freeze({ NODE_ENV: 'production',PLATFORM_PUBLIC_ORIGIN: profile.platformOrigin,
    PUBLIC_ORIGIN: profile.customerOrigin,ENTRA_CLIENT_ID: peer,PLATFORM_ENTRA_CLIENT_ID: clientId,
    PLATFORM_ENTRA_TENANT_ID: tenantId,PLATFORM_ENTRA_CLIENT_SECRET: values.entraClientSecret,
    PLATFORM_ENTRA_AUTHORITY: `${APPROVED_OUTBOUND_ORIGINS.microsoftIdentity}/${tenantId.toLowerCase()}`,
    PLATFORM_ASSURANCE_MODE: mode,PLATFORM_SECURITY_EPOCH: String(profile.platformSecurityEpoch),
    PLATFORM_OIDC_TRANSACTION_SECRET: values.oidcTransactionSecret,PLATFORM_CSRF_SECRET: values.csrfSecret,
    PLATFORM_AUDIT_HMAC_SECRET: values.auditHmacSecret,PLATFORM_CURSOR_SECRET: values.cursorSecret,
    PLATFORM_TENANT_AUDIT_HMAC_SECRET: values.tenantAuditHmacSecret,PLATFORM_PASSKEY_TRANSACTION_SECRET: values.passkeyTransactionSecret,
    PLATFORM_SERVICE_VERSION: read(env,'PROTECTED_SERVICE_VERSION'),PLATFORM_BUILD_ID: profile.apiCommit,
    PLATFORM_DATABASE_URL: profile.database.databaseUrl,PLATFORM_DATABASE_SSL: 'verify-full',
    PLATFORM_DATABASE_POOL_MAX: String(profile.database.databasePoolMax),PLATFORM_HOST: host,PLATFORM_PORT: optional('PORT') ?? '3000',
    PLATFORM_SESSION_TTL_SECONDS: optional('SESSION_TTL_SECONDS'),PLATFORM_AUTHENTICATION_MAX_AGE_SECONDS: '300',
    PLATFORM_OIDC_TRANSACTION_TTL_SECONDS: '300' });
  const base=loadPlatformConfig(authenticationEnvironment);
  const auditSegment=segmentId===undefined ? null : Object.freeze({ id: segmentId,environment: 'int',
    deploymentEpoch: profile.securityEpoch });
  const config=Object.freeze({ ...base,...profile.database,deploymentEnvironment: profile.environment,
    auditSegment,minimumCredentialCount });
  const cipher=createProtectedCustodyCipher({ environment: profile.environment,
    activeKeyId: read(env,'PROTECTED_CUSTODY_ACTIVE_KEY_ID'),keyring: read(env,'PROTECTED_CUSTODY_KEYRING'),
    lookupSecret: values.lookupSecret,forbiddenSecrets: material });
  return Object.freeze({ profile,config,cipher,ownerRecipient,ownerLocale,insightSources,
    authenticationFactory(context) {
      if (!context || ![Object.prototype,null].includes(Object.getPrototypeOf(context))
        || Reflect.ownKeys(context).length!==2 || Reflect.ownKeys(context).some(key=>{
          const field=Object.getOwnPropertyDescriptor(context,key);
          return !['pool','leasePool'].includes(key) || !Object.hasOwn(field,'value');
        })) fail('AUTHENTICATION_CONTEXT_INVALID');
      return createProtectedPlatformAuthentication({ env: authenticationEnvironment,pool: context.pool,leasePool: context.leasePool,
        protectedEnvironment: profile.environment,protectedSecurityEpoch: profile.securityEpoch,auditSegment,minimumCredentialCount });
    },
    synthetic: handoff===null ? null : Object.freeze({ browserSecret: handoff,intentSecret: intent }),
    owner: ownerHandoff===null ? null : Object.freeze({ browserSecret: ownerHandoff,intentSecret: ownerIntent }) });
}
