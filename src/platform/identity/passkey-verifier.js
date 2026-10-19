import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { decodeAttestationObject, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import { isInternalUuid } from '../../domain/identifiers.js';

const ALGORITHMS = [-7]; // ES256 / P-256; deliberately no runtime-dependent algorithm expansion.
const TRANSPORTS = new Set(['ble', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

export class PlatformPasskeyError extends Error {
  constructor() {
    super('PLATFORM_PASSKEY_REJECTED');
    this.name = 'PlatformPasskeyError';
    this.code = 'PLATFORM_PASSKEY_REJECTED';
  }
}

function reject() {
  throw new PlatformPasskeyError();
}

function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) reject();
}

function binary(value, minBytes, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(value)) reject();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length < minBytes || decoded.length > maxBytes || decoded.toString('base64url') !== value) reject();
  return decoded;
}

function challenge(value) {
  return binary(value, 32, 32);
}

function credentialIds(value, required = false) {
  if (!Array.isArray(value) || value.length > 5 || (required && value.length === 0)
    || new Set(value).size !== value.length) reject();
  return value.map((id) => {
    binary(id, 1, 1024);
    return { id };
  });
}

function keyBytes(value) {
  const bytes = binary(value, 32, 256);
  const key = decodeCredentialPublicKey(bytes);
  if (key.size !== 5 || key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1
    || !(key.get(-2) instanceof Uint8Array) || key.get(-2).length !== 32
    || !(key.get(-3) instanceof Uint8Array) || key.get(-3).length !== 32) reject();
  return bytes;
}

function envelope(value, purpose) {
  fields(value, ['id', 'rawId', 'type', 'response', 'clientExtensionResults'], ['authenticatorAttachment']);
  binary(value.id, 1, 1024);
  if (value.rawId !== value.id || value.type !== 'public-key'
    || (value.authenticatorAttachment !== undefined
      && !['platform', 'cross-platform'].includes(value.authenticatorAttachment))) reject();
  fields(value.clientExtensionResults, [], ['credProps']);
  if (value.clientExtensionResults.credProps !== undefined) {
    fields(value.clientExtensionResults.credProps, ['rk']);
    if (typeof value.clientExtensionResults.credProps.rk !== 'boolean') reject();
  }
  const response = value.response;
  if (purpose === 'registration') {
    fields(response, ['clientDataJSON', 'attestationObject'], ['transports']);
    binary(response.attestationObject, 1, 12_288);
    if (response.transports !== undefined && (!Array.isArray(response.transports) || response.transports.length > 6
      || response.transports.some((transport) => !TRANSPORTS.has(transport)))) reject();
  } else {
    fields(response, ['clientDataJSON', 'authenticatorData', 'signature'], ['userHandle']);
    binary(response.authenticatorData, 37, 1024);
    binary(response.signature, 8, 256);
    if (response.userHandle !== null && response.userHandle !== undefined) binary(response.userHandle, 32, 32);
  }
  const client = JSON.parse(binary(response.clientDataJSON, 1, 3072).toString('utf8'));
  if (!client || typeof client !== 'object' || Array.isArray(client)
    || (client.crossOrigin !== undefined && client.crossOrigin !== false) || client.topOrigin !== undefined) reject();
}

function counter(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) reject();
  return value;
}

function safeOperation(operation) {
  return async (...args) => {
    try {
      return await operation(...args);
    } catch {
      // Never retain raw SDK/client errors, biometric data, challenge contents or credential payloads.
      throw new PlatformPasskeyError();
    }
  };
}

// Inactive cryptographic adapter only: no enrollment authority, durable redemption or session issuance.
export function createPlatformPasskeyVerifier({ publicOrigin, environment } = {}) {
  let origin;
  let rpId;
  try {
    const parsed = new URL(publicOrigin);
    if (typeof publicOrigin !== 'string' || parsed.protocol !== 'https:' || parsed.origin !== publicOrigin
      || parsed.port !== '' || !parsed.hostname.includes('.')
      || parsed.hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || /^[\d.]+$/.test(parsed.hostname) || parsed.hostname.startsWith('[')
      || !['dev', 'int', 'prod'].includes(environment)) throw new Error();
    origin = parsed.origin;
    rpId = parsed.hostname;
  } catch {
    throw new TypeError('PLATFORM_PASSKEY_CONFIGURATION_INVALID');
  }

  return Object.freeze({
    createChallenge() {
      return randomBytes(32).toString('base64url');
    },

    registrationOptions: safeOperation(async ({ challenge: value, userHandle, userName, excludeCredentialIds = [] } = {}) => {
      const handle = binary(userHandle, 32, 32);
      if (typeof userName !== 'string' || userName.trim() !== userName || userName.length < 1 || userName.length > 80
        || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(userName)) reject();
      return generateRegistrationOptions({
        rpName: environment === 'prod' ? 'Conference Manager' : `Conference Manager ${environment.toUpperCase()}`,
        rpID: rpId, userID: handle, userName, userDisplayName: userName,
        challenge: challenge(value), timeout: 120_000, attestationType: 'none', supportedAlgorithmIDs: ALGORITHMS,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: credentialIds(excludeCredentialIds),
      });
    }),

    authenticationOptions: safeOperation(async ({ challenge: value, allowedCredentialIds } = {}) => {
      return generateAuthenticationOptions({ rpID: rpId, challenge: challenge(value), timeout: 120_000,
        userVerification: 'required', allowCredentials: credentialIds(allowedCredentialIds, true) });
    }),

    verifyRegistration: safeOperation(async ({ response, expectedChallenge } = {}) => {
      challenge(expectedChallenge);
      envelope(response, 'registration');
      // Reject all certificate-bearing formats before SDK verification can reach certificate/metadata helpers.
      const attestation = decodeAttestationObject(binary(response.response.attestationObject, 1, 12_288));
      if (attestation.get('fmt') !== 'none' || !(attestation.get('attStmt') instanceof Map)
        || attestation.get('attStmt').size !== 0) reject();
      const result = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin,
        expectedRPID: rpId, expectedType: 'webauthn.create', requireUserPresence: true,
        requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS });
      if (!result.verified || !result.registrationInfo.userVerified) reject();
      const info = result.registrationInfo;
      const publicKey = Buffer.from(info.credential.publicKey).toString('base64url');
      keyBytes(publicKey);
      return Object.freeze({ id: info.credential.id, publicKey, counter: counter(info.credential.counter),
        backupEligible: info.credentialDeviceType === 'multiDevice', backedUp: info.credentialBackedUp });
    }),

    verifyAuthentication: safeOperation(async ({ response, expectedChallenge, expectedOperatorId, credential } = {}) => {
      challenge(expectedChallenge);
      fields(credential, ['id', 'publicKey', 'counter', 'backupEligible', 'operatorId', 'environment', 'userHandle']);
      if (!isInternalUuid(expectedOperatorId) || credential.operatorId !== expectedOperatorId
        || credential.environment !== environment || typeof credential.backupEligible !== 'boolean') reject();
      binary(credential.userHandle, 32, 32);
      envelope(response, 'authentication');
      if (response.id !== credential.id
        || (response.response.userHandle != null && response.response.userHandle !== credential.userHandle)) reject();
      const result = await verifyAuthenticationResponse({ response, expectedChallenge,
        expectedOrigin: origin, expectedRPID: rpId, expectedType: 'webauthn.get', requireUserVerification: true,
        credential: { id: credential.id, publicKey: keyBytes(credential.publicKey), counter: counter(credential.counter) } });
      const info = result.authenticationInfo;
      if (!result.verified || !info.userVerified || info.credentialID !== credential.id
        || (info.credentialDeviceType === 'multiDevice') !== credential.backupEligible) reject();
      return Object.freeze({ credentialId: info.credentialID, newCounter: counter(info.newCounter),
        backupEligible: credential.backupEligible, backedUp: info.credentialBackedUp });
    }),
  });
}
