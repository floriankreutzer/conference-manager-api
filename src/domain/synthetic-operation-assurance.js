const PROFILES=Object.freeze({
  application_passkey: Object.freeze({ mode: 'application_passkey',normalContext: 'cm:pk:v1',freshContext: 'cm:pk:v1' }),
  microsoft_mfa: Object.freeze({ mode: 'microsoft_mfa',normalContext: 'cm:ms:mfa:v1',freshContext: 'cm:ms:fresh:v1' }),
});

// Root-owned protocol vocabulary only. This creates no principal, proof,
// session, permission, execution scope or credential-minimum exemption.
export function syntheticOperationAssurance(mode='application_passkey') {
  if (typeof mode!=='string' || !Object.hasOwn(PROFILES,mode)) {
    throw new TypeError('SYNTHETIC_OPERATION_ASSURANCE_MODE_INVALID');
  }
  return PROFILES[mode];
}
