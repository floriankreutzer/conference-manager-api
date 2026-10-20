import { createHmac } from 'node:crypto';
import { isIP, SocketAddress } from 'node:net';

// Accept the server-observed socket address only. HTTP forwarding headers are not
// a trusted source until a separately reviewed proxy contract exists.
export function createCustomerEmailSourceKey({ environment, secret } = {}) {
  if (!['dev','int','prod'].includes(environment) || typeof secret !== 'string'
    || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 512 || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new TypeError('CUSTOMER_EMAIL_SOURCE_KEY_INVALID');
  }
  const key = Buffer.from(secret,'utf8'); let destroyed = false;
  return Object.freeze({
    fingerprint(address) {
      if (destroyed) throw new Error('CUSTOMER_EMAIL_SOURCE_KEY_UNAVAILABLE');
      if (typeof address !== 'string' || address.length > 45 || address.includes('%') || !isIP(address)) {
        throw new TypeError('CUSTOMER_EMAIL_SOURCE_ADDRESS_INVALID');
      }
      // Canonicalize IPv6 spelling and IPv4-mapped IPv6 so the same address cannot
      // select independent counters using equivalent literal representations.
      let canonical = address;
      if (isIP(address) === 6) {
        canonical = new SocketAddress({ address,family: 'ipv6',port: 0 }).address;
        const mapped = canonical.startsWith('::ffff:') ? canonical.slice(7) : '';
        if (isIP(mapped) === 4) canonical = mapped;
      }
      return createHmac('sha256',key).update(`customer-email-source:v1:${environment}:${canonical}`,'ascii').digest('hex');
    },
    destroy() { destroyed = true; key.fill(0); },
  });
}
