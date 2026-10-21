import { createCustomerAccessCipher } from './persistence/customer-access-cipher.js';

const fail=()=>{ throw new TypeError('PROTECTED_CUSTODY_CONFIGURATION_INVALID'); };

// Shared server custody only, not a session/role/provider factory. Both owned
// surfaces clone the same retained keyring while keeping their own auth secrets.
export function createProtectedCustodyCipher({ environment,activeKeyId,keyring,lookupSecret,forbiddenSecrets=[] }={}) {
  if (typeof keyring!=='string' || keyring.length>4096 || !Array.isArray(forbiddenSecrets) || forbiddenSecrets.length>16
    || forbiddenSecrets.some(value=>typeof value!=='string' || Buffer.byteLength(value)>512)) fail();
  let rows;try { rows=JSON.parse(keyring); } catch { fail(); }
  if (!Array.isArray(rows) || rows.length<1 || rows.length>8) fail();
  const keys=new Map();
  try {
    for (const row of rows) {
      if (!row || typeof row!=='object' || Array.isArray(row) || Object.keys(row).sort().join(',')!=='id,key'
        || typeof row.id!=='string' || keys.has(row.id) || typeof row.key!=='string'
        || !/^[A-Za-z0-9_-]{43}$/.test(row.key)) fail();
      const key=Buffer.from(row.key,'base64url');
      if (key.length!==32 || key.toString('base64url')!==row.key
        || forbiddenSecrets.some(value=>key.equals(Buffer.from(value)))) { key.fill(0);fail(); }
      keys.set(row.id,key);
    }
    return createCustomerAccessCipher({ environment,activeKeyId,keys,lookupSecret });
  } finally { for (const key of keys.values()) key.fill(0); }
}
