import { loadConfig } from './config.js';
import { loadProtectedRuntimeProfile,protectedRuntimeConfigurationKeys } from './protected-runtime-config.js';
import { isInternalUuid } from './domain/identifiers.js';
import { createCustomerAccessCipher } from './persistence/customer-access-cipher.js';
import { createResendEmailClient } from './integrations/resend-email-client.js';

const PREFIX='PROTECTED_CUSTOMER_';
const KEYS=['ENTRA_CLIENT_ID','ENTRA_CLIENT_SECRET','CSRF_SECRET','EMAIL_FLOW_SECRET','EMAIL_CODE_SECRET',
  'EMAIL_SOURCE_SECRET','MICROSOFT_FLOW_SECRET','SESSION_TTL_SECONDS','HOST','PORT','MAIL_API_KEY','MAIL_SENDER'];
const fail=code=>{ throw new TypeError(`PROTECTED_CUSTOMER_CONFIG_${code}`); };
function read(env,key,optional=false) {
  if (optional && !Object.hasOwn(env,key)) return undefined;
  const own=Object.getOwnPropertyDescriptor(env,key);
  if (!own || !Object.hasOwn(own,'value') || typeof own.value!=='string' || !own.value
    || own.value!==own.value.trim() || /[\u0000-\u001f\u007f]/.test(own.value)) fail('VALUE_INVALID');
  return own.value;
}
function secret(env,key) {
  const value=read(env,key);if (Buffer.byteLength(value)<32 || Buffer.byteLength(value)>512) fail('SECRET_INVALID');return value;
}
function keyring(env,values) {
  const encoded=read(env,'PROTECTED_CUSTODY_KEYRING');if (encoded.length>4096) fail('CUSTODY_INVALID');
  let rows;try { rows=JSON.parse(encoded); } catch { fail('CUSTODY_INVALID'); }
  if (!Array.isArray(rows) || rows.length<1 || rows.length>8) fail('CUSTODY_INVALID');
  const keys=new Map();
  try {
  for (const row of rows) {
    if (!row || typeof row!=='object' || Array.isArray(row) || Object.keys(row).sort().join(',')!=='id,key'
      || typeof row.id!=='string' || keys.has(row.id) || typeof row.key!=='string'
      || !/^[A-Za-z0-9_-]{43}$/.test(row.key)) fail('CUSTODY_INVALID');
    const key=Buffer.from(row.key,'base64url');
    if (key.length!==32 || key.toString('base64url')!==row.key || values.some(value=>key.equals(Buffer.from(value)))) {
      key.fill(0);fail('CUSTODY_INVALID');
    }
    keys.set(row.id,key);
  }
  return keys;
  } catch (error) { for (const key of keys.values()) key.fill(0);throw error; }
}

// Explicit owned startup input only. Compatibility names are constructed in a
// private local object for canonical production validators; no inherited value
// is changed or copied wholesale, and no database/provider request occurs here.
export function loadProtectedCustomerConfiguration(env) {
  const profile=loadProtectedRuntimeProfile(env,{ surface: 'customer' });
  const allowed=new Set([...protectedRuntimeConfigurationKeys('customer'),...KEYS.map(key=>PREFIX+key)]);
  if (Reflect.ownKeys(env).some(key=>key.startsWith('PROTECTED_') && !allowed.has(key))) fail('UNKNOWN_KEY');
  const own=key=>read(env,PREFIX+key),optional=key=>read(env,PREFIX+key,true);
  const values={ csrfSecret: secret(env,PREFIX+'CSRF_SECRET'),auditHmacSecret: secret(env,'PROTECTED_TENANT_AUDIT_HMAC_SECRET'),
    entraClientSecret: secret(env,PREFIX+'ENTRA_CLIENT_SECRET'),emailFlowSecret: secret(env,PREFIX+'EMAIL_FLOW_SECRET'),
    emailCodeSecret: secret(env,PREFIX+'EMAIL_CODE_SECRET'),emailSourceSecret: secret(env,PREFIX+'EMAIL_SOURCE_SECRET'),
    microsoftFlowSecret: secret(env,PREFIX+'MICROSOFT_FLOW_SECRET'),lookupSecret: secret(env,'PROTECTED_CUSTODY_LOOKUP_SECRET') };
  const handoff=profile.syntheticEnabled ? secret(env,'PROTECTED_HANDOFF_SECRET') : null;
  if (!profile.syntheticEnabled && Object.hasOwn(env,'PROTECTED_HANDOFF_SECRET')) fail('INACTIVE_HANDOFF_FORBIDDEN');
  const material=[...Object.values(values),...(handoff===null ? [] : [handoff])];
  if (new Set(material).size!==material.length
    || material.includes(decodeURIComponent(new URL(profile.database.databaseUrl).password))) fail('SECRET_ALIAS_FORBIDDEN');
  const peer=read(env,'PROTECTED_PEER_ENTRA_CLIENT_ID'),clientId=own('ENTRA_CLIENT_ID');
  if (!isInternalUuid(peer) || !isInternalUuid(clientId) || peer.toLowerCase()===clientId.toLowerCase()) fail('CLIENT_ALIAS_FORBIDDEN');
  const host=optional('HOST') ?? '0.0.0.0';if (!['0.0.0.0','127.0.0.1','::'].includes(host)) fail('HOST_INVALID');
  const base=loadConfig({ NODE_ENV: 'production',PUBLIC_ORIGIN: profile.customerOrigin,
    DATABASE_URL: profile.database.databaseUrl,DATABASE_SSL: 'verify-full',
    CSRF_SECRET: values.csrfSecret,AUDIT_HMAC_SECRET: values.auditHmacSecret,
    ENTRA_CLIENT_ID: clientId,ENTRA_CLIENT_SECRET: values.entraClientSecret,OIDC_TRANSACTION_SECRET: values.microsoftFlowSecret,
    SERVICE_VERSION: read(env,'PROTECTED_SERVICE_VERSION'),BUILD_ID: profile.apiCommit,
    HOST: host,PORT: optional('PORT'),SESSION_TTL_SECONDS: optional('SESSION_TTL_SECONDS') });
  // Runtime security mode remains production in DEV/INT/PROD. Only this explicit
  // protected envelope selects the independent deployment namespace after the
  // canonical production constraints have passed; ordinary loaders are unchanged.
  const config=Object.freeze({ ...base,...profile.database,deploymentEnvironment: profile.environment });
  const mailKey=optional('MAIL_API_KEY'),sender=optional('MAIL_SENDER');
  if ((mailKey===undefined)!==(sender===undefined)) fail('MAIL_CONFIGURATION_INCOMPLETE');
  if (mailKey!==undefined && material.includes(mailKey)) fail('SECRET_ALIAS_FORBIDDEN');
  const mailProvider=mailKey===undefined ? null : createResendEmailClient({ apiKey: mailKey,sender,environment: profile.environment });
  const keys=keyring(env,material);let cipher;
  try { cipher=createCustomerAccessCipher({ environment: profile.environment,keys,
    activeKeyId: read(env,'PROTECTED_CUSTODY_ACTIVE_KEY_ID'),lookupSecret: values.lookupSecret }); }
  finally { for (const key of keys.values()) key.fill(0); }
  return Object.freeze({ profile,config,cipher,mailProvider,
    authentication: Object.freeze({ emailFlowSecret: values.emailFlowSecret,emailCodeSecret: values.emailCodeSecret,
      emailSourceSecret: values.emailSourceSecret,microsoftFlowSecret: values.microsoftFlowSecret,
      synthetic: handoff===null ? null : Object.freeze({ platformOrigin: profile.platformOrigin,
        platformSecurityEpoch: profile.platformSecurityEpoch,browserSecret: handoff,sourceSecret: values.emailSourceSecret }) }),
  });
}
