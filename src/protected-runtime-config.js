import { isIP } from 'node:net';
import { loadDatabaseConfig } from './config.js';
import { isInternalUuid } from './domain/identifiers.js';

const COMMON_KEYS=new Set(['PROTECTED_ENVIRONMENT','PROTECTED_SECURITY_EPOCH','PROTECTED_CUSTOMER_ORIGIN','PROTECTED_PLATFORM_ORIGIN',
  'PROTECTED_API_COMMIT','PROTECTED_FRONTEND_COMMIT','PROTECTED_SYNTHETIC_ENABLED','PROTECTED_DATABASE_SSL',
  'PROTECTED_DATABASE_POOL_MAX','PROTECTED_LEASE_POOL_MAX','PROTECTED_PLATFORM_SECURITY_EPOCH','PROTECTED_HANDOFF_SECRET',
  'PROTECTED_CUSTODY_ACTIVE_KEY_ID','PROTECTED_CUSTODY_KEYRING','PROTECTED_CUSTODY_LOOKUP_SECRET','PROTECTED_TENANT_AUDIT_HMAC_SECRET',
  'PROTECTED_PEER_ENTRA_CLIENT_ID','PROTECTED_SERVICE_VERSION','PROTECTED_HOSTED_FRONTEND_ENABLED',
  'PROTECTED_HOSTED_FRONTEND_SHA256','PROTECTED_OWNER_CUSTOMER_ACCESS_ENABLED','PROTECTED_OWNER_HANDOFF_SECRET',
  'PROTECTED_SYNTHETIC_PARTICIPANTS_ENABLED']);
const LEGACY=/^(?:DATABASE_URL|DATABASE_SSL|PUBLIC_ORIGIN|CSRF_SECRET|AUDIT_HMAC_SECRET|ENTRA_|OIDC_|PLATFORM_|DEMO_)/;
const fail=code=>{ throw new TypeError(`PROTECTED_RUNTIME_CONFIG_${code}`); };
function required(env,key) {
  const descriptor=Object.getOwnPropertyDescriptor(env,key);
  if (!descriptor || !Object.hasOwn(descriptor,'value') || typeof descriptor.value!=='string' || !descriptor.value
    || descriptor.value!==descriptor.value.trim() || /[\u0000-\u001f\u007f]/.test(descriptor.value)) fail('REQUIRED');
  return descriptor.value;
}
function optional(env,key) {
  return Object.hasOwn(env,key) ? required(env,key) : undefined;
}
function integer(env,key,fallback,max) {
  const value=optional(env,key);if (value===undefined) return fallback;
  if (!/^[1-9]\d{0,2}$/.test(value) || Number(value)>max) fail('POOL_BOUND_INVALID');return Number(value);
}
function origin(value) {
  let url;try { url=new URL(value); } catch { fail('ORIGIN_INVALID'); }
  if (value.length>253 || url.protocol!=='https:' || url.origin!==value || url.port || isIP(url.hostname)
    || !url.hostname.includes('.') || !url.hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    fail('ORIGIN_INVALID');
  }
  return value;
}
function databaseUrl(value,environment,surface) {
  let url,role,password;
  try { url=new URL(value);role=decodeURIComponent(url.username);password=decodeURIComponent(url.password); }
  catch { fail('DATABASE_INVALID'); }
  if (value.length>4096 || !['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || url.search || url.hash
    || url.pathname==='/' || url.pathname.split('/').length!==2 || role!==`cm_protected_${environment}_${surface}`
    || password.length<32 || password.length>512 || /[\u0000-\u001f\u007f]/.test(password)) fail('DATABASE_INVALID');
  return value;
}

// Full owned configuration loaders add their exact surface-specific keys to
// this immutable public key inventory. It contains names only, never values.
export function protectedRuntimeConfigurationKeys(surface) {
  if (!['customer','platform'].includes(surface)) fail('SURFACE_INVALID');
  return Object.freeze([...COMMON_KEYS,`PROTECTED_${surface.toUpperCase()}_DATABASE_URL`]);
}

// Shared immutable profile envelope, not an authentication/provider factory.
// Each process receives only its surface's prefixed credentials; compatibility
// names exist solely in local validator input; the inherited environment is never mutated.
export function loadProtectedRuntimeProfile(env,{ surface }={}) {
  if (!env || typeof env!=='object' || Array.isArray(env) || !['customer','platform'].includes(surface)) fail('SURFACE_INVALID');
  const own=`PROTECTED_${surface.toUpperCase()}_`;
  for (const key of Reflect.ownKeys(env)) {
    if (typeof key!=='string') fail('KEY_INVALID');
    if (LEGACY.test(key)) fail('LEGACY_FORBIDDEN');
    if (key.startsWith('PROTECTED_') && !COMMON_KEYS.has(key) && !key.startsWith(own)) fail('CROSS_SURFACE_FORBIDDEN');
  }
  if (required(env,'NODE_ENV')!=='production') fail('PRODUCTION_MODE_REQUIRED');
  const environment=required(env,'PROTECTED_ENVIRONMENT'),securityEpoch=required(env,'PROTECTED_SECURITY_EPOCH');
  if (!['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) fail('SCOPE_INVALID');
  const customerOrigin=origin(required(env,'PROTECTED_CUSTOMER_ORIGIN')),platformOrigin=origin(required(env,'PROTECTED_PLATFORM_ORIGIN'));
  if (customerOrigin===platformOrigin) fail('ORIGIN_ALIAS_FORBIDDEN');
  const platformSecurityEpoch=required(env,'PROTECTED_PLATFORM_SECURITY_EPOCH');
  if (!/^[1-9]\d{0,9}$/.test(platformSecurityEpoch)
    || Number(platformSecurityEpoch)<2 || Number(platformSecurityEpoch)>2147483647) fail('PLATFORM_EPOCH_INVALID');
  const synthetic=optional(env,'PROTECTED_SYNTHETIC_ENABLED') ?? 'false';
  if (!['true','false'].includes(synthetic) || synthetic==='true' && environment==='prod') fail('SYNTHETIC_INVALID');
  const participants=optional(env,'PROTECTED_SYNTHETIC_PARTICIPANTS_ENABLED') ?? 'false';
  if (!['true','false'].includes(participants)
    || participants==='true' && (environment==='prod' || synthetic!=='true')) fail('SYNTHETIC_PARTICIPANTS_INVALID');
  const ownerAccess=optional(env,'PROTECTED_OWNER_CUSTOMER_ACCESS_ENABLED') ?? 'false';
  if (!['true','false'].includes(ownerAccess)) fail('OWNER_CUSTOMER_ACCESS_INVALID');
  const apiCommit=required(env,'PROTECTED_API_COMMIT'),frontendCommit=required(env,'PROTECTED_FRONTEND_COMMIT');
  if (![apiCommit,frontendCommit].every(value=>/^[a-f0-9]{40}$/.test(value))) fail('ARTIFACT_PAIR_INVALID');
  const hosted=optional(env,'PROTECTED_HOSTED_FRONTEND_ENABLED') ?? 'false';
  const frontendDigest=optional(env,'PROTECTED_HOSTED_FRONTEND_SHA256');
  if (!['true','false'].includes(hosted) || (hosted==='true'
    ? !/^[a-f0-9]{64}$/.test(frontendDigest ?? '') : frontendDigest!==undefined)) fail('HOSTED_FRONTEND_INVALID');
  if ((optional(env,'PROTECTED_DATABASE_SSL') ?? 'verify-full')!=='verify-full') fail('DATABASE_TLS_REQUIRED');
  const poolMax=integer(env,'PROTECTED_DATABASE_POOL_MAX',2,5),leaseMax=integer(env,'PROTECTED_LEASE_POOL_MAX',1,5);
  if (poolMax+leaseMax>8) fail('POOL_BOUND_INVALID');
  const selectedDatabase=databaseUrl(required(env,`${own}DATABASE_URL`),environment,surface);
  const database=loadDatabaseConfig({ NODE_ENV: 'production',DATABASE_URL: selectedDatabase,
    DATABASE_SSL: 'verify-full',DATABASE_POOL_MAX: String(poolMax) },'production');
  const applicationName=surface==='customer' ? 'conference-manager-api' : 'conference-manager-platform-api';
  const selected=Object.freeze({ ...database,mode: 'production',applicationName });
  return Object.freeze({ surface,environment,securityEpoch: securityEpoch.toLowerCase(),
    platformSecurityEpoch: Number(platformSecurityEpoch),customerOrigin,platformOrigin,syntheticEnabled: synthetic==='true',
    ownerCustomerAccessEnabled: ownerAccess==='true',syntheticParticipantsEnabled: participants==='true',
    apiCommit,frontendCommit,hostedFrontendSha256: hosted==='true' ? frontendDigest : null,
    database: selected,leaseDatabase: Object.freeze({ ...selected,databasePoolMax: leaseMax }),
  });
}
