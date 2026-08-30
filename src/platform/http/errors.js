const SAFE_PLATFORM_CODE = /^PLATFORM_[A-Z0-9_]{1,88}$/;

export class PlatformHttpError extends Error {
  constructor(statusCode, code, { securityCategory = null } = {}) {
    if (!Number.isSafeInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      throw new TypeError('PLATFORM_HTTP_STATUS_INVALID');
    }
    if (typeof code !== 'string' || !SAFE_PLATFORM_CODE.test(code)) {
      throw new TypeError('PLATFORM_HTTP_ERROR_CODE_INVALID');
    }
    if (securityCategory !== null && !['authentication', 'authorization'].includes(securityCategory)) {
      throw new TypeError('PLATFORM_HTTP_SECURITY_CATEGORY_INVALID');
    }
    super(code);
    this.name = 'PlatformHttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.securityCategory = securityCategory;
  }
}

function safeServiceCode(error, fallback) {
  return typeof error?.code === 'string' && SAFE_PLATFORM_CODE.test(error.code)
    ? error.code
    : fallback;
}

export function asPlatformHttpError(error) {
  if (error instanceof PlatformHttpError) return error;
  if (error?.name === 'PlatformOperationInputError') {
    return new PlatformHttpError(400, safeServiceCode(error, 'PLATFORM_OPERATION_INPUT_INVALID'));
  }
  if (error?.name === 'PlatformOperationDeniedError' || error?.name === 'PlatformAuthorizationError') {
    return new PlatformHttpError(403, safeServiceCode(error, 'PLATFORM_AUTHORIZATION_DENIED'), {
      securityCategory: 'authorization',
    });
  }
  if (error?.name === 'PlatformOperationConflictError') {
    return new PlatformHttpError(409, safeServiceCode(error, 'PLATFORM_OPERATION_CONFLICT'));
  }
  if (error?.name === 'PlatformOperationUnavailableError') {
    return new PlatformHttpError(503, safeServiceCode(error, 'PLATFORM_OPERATION_UNAVAILABLE'));
  }
  if (
    error?.name === 'PlatformIdentityError'
    || error?.name === 'PlatformAuthenticationError'
    || error?.name === 'PlatformSessionError'
  ) {
    return new PlatformHttpError(401, 'PLATFORM_AUTHENTICATION_FAILED', {
      securityCategory: 'authentication',
    });
  }
  return new PlatformHttpError(500, 'PLATFORM_INTERNAL_ERROR');
}
