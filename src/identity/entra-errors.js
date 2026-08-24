export class EntraAuthenticationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EntraAuthenticationError';
    this.code = code;
  }
}
