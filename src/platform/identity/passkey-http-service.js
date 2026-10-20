import { PlatformIdentityError } from './errors.js';

export function createPlatformPasskeyHttpService({ authService, enrollmentFlow, lifecycleService, assuranceMode, environment } = {}) {
  if (!['passkey_setup','application_passkey'].includes(assuranceMode) || !['dev','int','prod'].includes(environment)
    || !['pendingAuthentication','complete'].every(name => typeof authService?.[name] === 'function')
    || !['start','continueSetup','pending','register','complete','beginAddition']
      .every(name => typeof enrollmentFlow?.[name] === 'function')
    || !['list','startAddition','startRevocation','revoke'].every(name => typeof lifecycleService?.[name] === 'function')) {
    throw new TypeError('PLATFORM_PASSKEY_HTTP_SERVICE_PORTS_REQUIRED');
  }
  return Object.freeze({
    configuration() { return Object.freeze({ mode: assuranceMode, environment, minimumPasskeys: 2 }); },
    async pendingAuthentication(cookie) { return authService.pendingAuthentication(cookie); },
    async authenticate(value) {
      const pending = await authService.pendingAuthentication(value.cookie);
      if (pending.status !== 'passkey_required') throw new PlatformIdentityError('PLATFORM_PASSKEY_AUTHENTICATION_REJECTED');
      return pending.setupRequired ? enrollmentFlow.continueSetup(value) : authService.complete(value);
    },
    async startEnrollment(value) { return enrollmentFlow.start(value); },
    async pendingEnrollment(cookie) { return enrollmentFlow.pending(cookie); },
    async register(value) { return enrollmentFlow.register(value); },
    async completeEnrollment(value) { return enrollmentFlow.complete(value); },
    async listKeys(request) { return lifecycleService.list(request); },
    async startAddition(principal) { return lifecycleService.startAddition(principal); },
    async completeAddition(value) { return enrollmentFlow.beginAddition(value); },
    async startRevocation(principal, credentialId) { return lifecycleService.startRevocation(principal, credentialId); },
    async completeRevocation(value) { return lifecycleService.revoke(value); },
  });
}
