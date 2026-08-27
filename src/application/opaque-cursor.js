import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN = /^([A-Za-z0-9_-]{1,3072})\.([A-Za-z0-9_-]{43})$/;

function key(secret, purpose) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new TypeError('CURSOR_SECRET_INVALID');
  }
  if (typeof purpose !== 'string' || !/^[a-z][a-z0-9._-]{2,63}$/.test(purpose)) {
    throw new TypeError('CURSOR_PURPOSE_INVALID');
  }
  return createHmac('sha256', secret)
    .update(`conference-manager-cursor-key:${purpose}`, 'utf8')
    .digest();
}

function signature(encoded, secret, purpose) {
  return createHmac('sha256', key(secret, purpose)).update(encoded, 'ascii').digest();
}

export function encodeOpaqueCursor(payload, { secret, purpose } = {}) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(encoded, secret, purpose).toString('base64url')}`;
}

export function decodeOpaqueCursor(value, { secret, purpose } = {}) {
  if (typeof value !== 'string') throw new TypeError('CURSOR_INVALID');
  const match = value.match(TOKEN);
  if (!match) throw new TypeError('CURSOR_INVALID');
  const supplied = Buffer.from(match[2], 'base64url');
  const expected = signature(match[1], secret, purpose);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new TypeError('CURSOR_INVALID');
  }
  try {
    return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('CURSOR_INVALID');
  }
}
