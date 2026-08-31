export const MICROSOFT365_PROVIDER = 'microsoft365';

export const MICROSOFT365_BASE_PERMISSIONS = Object.freeze([
  'Place.Read.All',
  'Calendars.ReadBasic.All',
]);

export const MICROSOFT365_CALENDAR_WRITE_PERMISSION = 'Calendars.ReadWrite';

export const MICROSOFT365_VERIFICATION = Object.freeze({
  CONNECTED: 'connected',
  DEGRADED: 'degraded',
  REVOKED: 'revoked',
});

export class Microsoft365ProviderError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = 'Microsoft365ProviderError';
    this.code = code;
  }
}
