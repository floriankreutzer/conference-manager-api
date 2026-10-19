const RUNTIME_ENVIRONMENTS = Object.freeze({
  development: 'dev',
  test: null,
  pilot: 'int',
  production: 'prod',
});

// Deployment names do not select a weaker runtime/security profile.
export function resolveDeploymentEnvironment(value, mode) {
  if (!Object.hasOwn(RUNTIME_ENVIRONMENTS, mode)) {
    throw new TypeError('DEPLOYMENT_RUNTIME_MODE_INVALID');
  }
  const expected = RUNTIME_ENVIRONMENTS[mode];
  if (value === undefined) return expected;
  if (!['dev', 'int', 'prod'].includes(value)) {
    throw new TypeError('DEPLOYMENT_ENVIRONMENT_INVALID');
  }
  if (value !== expected) throw new TypeError('DEPLOYMENT_ENVIRONMENT_MODE_MISMATCH');
  return value;
}
