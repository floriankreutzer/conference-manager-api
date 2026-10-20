// Application orchestration only. The transport supplies the observed socket
// address; no forwarding header or browser-selected source becomes abuse authority.
export function createCustomerEmailAuthenticationService({ challenges,admission,sourceKey } = {}) {
  if (!challenges || ['request','pending','verify'].some(name => typeof challenges[name] !== 'function')
    || !admission || ['choices','select'].some(name => typeof admission[name] !== 'function')
    || typeof sourceKey?.fingerprint !== 'function') throw new TypeError('CUSTOMER_EMAIL_AUTHENTICATION_CONFIGURATION_INVALID');
  return Object.freeze({
    request({ recipient,locale,sourceAddress } = {}) {
      return challenges.request({ recipient,locale,sourceKey: sourceKey.fingerprint(sourceAddress) });
    },
    pending({ challengeId,browserToken } = {}) { return challenges.pending({ challengeId,browserToken }); },
    verify({ challengeId,browserToken,csrfToken,code,sourceAddress } = {}) {
      return challenges.verify({ challengeId,browserToken,csrfToken,code,sourceKey: sourceKey.fingerprint(sourceAddress) });
    },
    choices({ challengeId,browserToken } = {}) { return admission.choices({ challengeId,browserToken }); },
    select({ challengeId,browserToken,csrfToken,correlationId } = {},command) {
      return admission.select({ challengeId,browserToken,csrfToken,correlationId },command);
    },
  });
}
