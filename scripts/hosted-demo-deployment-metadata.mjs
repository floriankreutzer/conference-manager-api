const COMMIT_REF_PATTERN = /^[0-9a-f]{40}$/;
const EXPECTED_REPOSITORY = 'floriankreutzer/conference-manager-api';
const EXPECTED_BRANCH = 'main';
const ALLOWED_SERVICE_NAMES = new Set([
  'conference-manager-demo',
  'conference-manager-ops-demo',
]);

export const HOSTED_DEMO_DEPLOYMENT_METADATA_PATH = 'assets/hosted-demo-deployment.json';

function requireExact(value, expected, code) {
  if (value !== expected) throw new Error(code);
  return value;
}

function requireCommitRef(value, code) {
  if (typeof value !== 'string' || !COMMIT_REF_PATTERN.test(value)) throw new Error(code);
  return value;
}

export function createHostedDemoDeploymentMetadata(env, frontendRef) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('HOSTED_DEMO_DEPLOYMENT_ENV_REQUIRED');
  }
  if (env.RENDER !== 'true') return null;

  const serviceName = env.RENDER_SERVICE_NAME;
  if (!ALLOWED_SERVICE_NAMES.has(serviceName)) {
    throw new Error('HOSTED_DEMO_RENDER_SERVICE_NAME_INVALID');
  }

  return Object.freeze({
    schemaVersion: 1,
    provider: 'render',
    repository: requireExact(
      env.RENDER_GIT_REPO_SLUG,
      EXPECTED_REPOSITORY,
      'HOSTED_DEMO_RENDER_REPOSITORY_INVALID',
    ),
    branch: requireExact(
      env.RENDER_GIT_BRANCH,
      EXPECTED_BRANCH,
      'HOSTED_DEMO_RENDER_BRANCH_INVALID',
    ),
    serviceName,
    runtimeRef: requireCommitRef(env.RENDER_GIT_COMMIT, 'HOSTED_DEMO_RENDER_COMMIT_INVALID'),
    frontendRef: requireCommitRef(frontendRef, 'HOSTED_DEMO_FRONTEND_REF_INVALID'),
  });
}

export function serializeHostedDemoDeploymentMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('HOSTED_DEMO_DEPLOYMENT_METADATA_REQUIRED');
  }
  return `${JSON.stringify(metadata)}\n`;
}
