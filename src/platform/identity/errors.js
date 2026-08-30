export class PlatformIdentityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PlatformIdentityError';
    this.code = code;
  }
}

export class PlatformAuthorizationError extends Error {
  constructor(code = 'PLATFORM_AUTHORIZATION_DENIED') {
    super(code);
    this.name = 'PlatformAuthorizationError';
    this.code = code;
  }
}

export class PlatformSessionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PlatformSessionError';
    this.code = code;
  }
}
