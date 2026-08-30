import { PlatformIdentityError } from './errors.js';

const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/;

function invalid(code) {
  throw new PlatformIdentityError(code);
}

function exactString(value, expected, code) {
  if (typeof value !== 'string' || value !== expected) invalid(code);
  return value;
}

function utcInstant(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalid('PLATFORM_AUTHENTICATION_TIME_INVALID');
  }
  return value;
}

export function createPlatformClaimPolicy({
  provider,
  issuer,
  audience,
  tenantReference,
  mfaAuthenticationContext,
  stepUpAuthenticationContext,
} = {}) {
  for (const [value, code] of [
    [provider, 'PLATFORM_PROVIDER_REQUIRED'],
    [issuer, 'PLATFORM_ISSUER_REQUIRED'],
    [audience, 'PLATFORM_AUDIENCE_REQUIRED'],
    [tenantReference, 'PLATFORM_TENANT_REFERENCE_REQUIRED'],
    [mfaAuthenticationContext, 'PLATFORM_MFA_CONTEXT_REQUIRED'],
    [stepUpAuthenticationContext, 'PLATFORM_STEP_UP_CONTEXT_REQUIRED'],
  ]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 512) throw new TypeError(code);
  }
  if (mfaAuthenticationContext === stepUpAuthenticationContext) {
    throw new TypeError('PLATFORM_AUTHENTICATION_CONTEXTS_MUST_DIFFER');
  }

  return Object.freeze({
    normalize(verified) {
      if (!verified || verified.verified !== true || !verified.claims) {
        invalid('PLATFORM_ASSERTION_NOT_VERIFIED');
      }
      const claims = verified.claims;
      if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
        invalid('PLATFORM_CLAIMS_INVALID');
      }
      if (
        Object.keys(claims).sort().join(',')
        !== 'audience,authenticatedAt,authenticationContext,issuer,provider,subjectReference,tenantReference'
      ) invalid('PLATFORM_CLAIMS_FIELDS_INVALID');
      if (
        claims.roles !== undefined
        || claims.groups !== undefined
        || claims.permissions !== undefined
        || claims.customerTenantId !== undefined
      ) {
        invalid('PLATFORM_AUTHORITY_CLAIMS_FORBIDDEN');
      }
      exactString(claims.provider, provider, 'PLATFORM_PROVIDER_MISMATCH');
      exactString(claims.issuer, issuer, 'PLATFORM_ISSUER_MISMATCH');
      exactString(claims.audience, audience, 'PLATFORM_AUDIENCE_MISMATCH');
      exactString(claims.tenantReference, tenantReference, 'PLATFORM_OPERATOR_TENANT_MISMATCH');
      if (typeof claims.subjectReference !== 'string' || !REFERENCE_PATTERN.test(claims.subjectReference)) {
        invalid('PLATFORM_SUBJECT_INVALID');
      }
      const context = claims.authenticationContext;
      const level = context === stepUpAuthenticationContext
        ? 'step_up'
        : context === mfaAuthenticationContext ? 'mfa' : null;
      if (!level) invalid('PLATFORM_ASSURANCE_CONTEXT_REJECTED');
      return Object.freeze({
        provider,
        tenantReference,
        subjectReference: claims.subjectReference,
        assurance: Object.freeze({
          level,
          authenticationContext: context,
          authenticatedAt: utcInstant(claims.authenticatedAt),
        }),
      });
    },
  });
}
