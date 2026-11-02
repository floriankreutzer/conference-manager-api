const EXPECTED_REPOSITORY = 'floriankreutzer/conference-manager-api';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TASK = 'deploy:jira:render-pair';

const ENVIRONMENTS = Object.freeze({
  int: Object.freeze({
    customer: 'https://conference-manager-demo.onrender.com',
    platform: 'https://conference-manager-ops-demo.onrender.com',
  }),
});

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function requireSha(value, code) {
  if (!SHA_PATTERN.test(value)) throw new Error(code);
  return value;
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new Error(code);
  }
  return value;
}

async function jsonRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP_${response.status}_${url}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function validateMetadata(metadata, expectedService, expectedApiSha, expectedFrontendSha) {
  exactKeys(
    metadata,
    ['schemaVersion', 'provider', 'repository', 'branch', 'serviceName', 'runtimeRef', 'frontendRef'],
    'DEPLOYMENT_METADATA_SHAPE_INVALID',
  );
  if (metadata.schemaVersion !== 1) throw new Error('DEPLOYMENT_METADATA_SCHEMA_INVALID');
  if (metadata.provider !== 'render') throw new Error('DEPLOYMENT_METADATA_PROVIDER_INVALID');
  if (metadata.repository !== EXPECTED_REPOSITORY) throw new Error('DEPLOYMENT_METADATA_REPOSITORY_INVALID');
  if (metadata.branch !== 'main') throw new Error('DEPLOYMENT_METADATA_BRANCH_INVALID');
  if (metadata.serviceName !== expectedService) throw new Error('DEPLOYMENT_METADATA_SERVICE_INVALID');
  if (metadata.runtimeRef !== expectedApiSha) throw new Error('DEPLOYMENT_METADATA_API_SHA_MISMATCH');
  if (metadata.frontendRef !== expectedFrontendSha) throw new Error('DEPLOYMENT_METADATA_FRONTEND_SHA_MISMATCH');
}

async function githubApi(path, options = {}) {
  const token = required('GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GITHUB_API_${response.status}: ${body.slice(0, 500)}`);
  }
  return response.status === 204 ? null : response.json();
}

async function findExistingSuccess(repo, sha, environment) {
  const query = new URLSearchParams({
    sha,
    environment,
    task: TASK,
    per_page: '100',
  });
  const deployments = await githubApi(`/repos/${repo}/deployments?${query}`);
  for (const deployment of deployments) {
    const statuses = await githubApi(
      `/repos/${repo}/deployments/${deployment.id}/statuses?per_page=100`,
    );
    if (statuses.some((status) => status.state === 'success')) return deployment;
  }
  return null;
}

async function main() {
  const environment = required('DEPLOYMENT_ENVIRONMENT');
  const config = ENVIRONMENTS[environment];
  if (!config) throw new Error('DEPLOYMENT_ENVIRONMENT_NOT_CONFIGURED');

  const apiSha = requireSha(required('EXPECTED_API_SHA'), 'EXPECTED_API_SHA_INVALID');
  const frontendSha = requireSha(required('EXPECTED_FRONTEND_SHA'), 'EXPECTED_FRONTEND_SHA_INVALID');
  const repository = required('GITHUB_REPOSITORY');

  const [customer, platform] = await Promise.all([
    jsonRequest(`${config.customer}/assets/hosted-demo-deployment.json`),
    jsonRequest(`${config.platform}/assets/hosted-demo-deployment.json`),
  ]);

  validateMetadata(customer, 'conference-manager-demo', apiSha, frontendSha);
  validateMetadata(platform, 'conference-manager-ops-demo', apiSha, frontendSha);

  const existing = await findExistingSuccess(repository, apiSha, environment);
  if (existing) {
    console.log(`Existing successful normalized deployment: ${existing.id}`);
    return;
  }

  const deployment = await githubApi(`/repos/${repository}/deployments`, {
    method: 'POST',
    body: JSON.stringify({
      ref: apiSha,
      task: TASK,
      environment,
      description: 'Verified Render Customer + Platform deployment pair for Jira traceability',
      auto_merge: false,
      required_contexts: [],
      payload: {
        schemaVersion: 1,
        provider: 'render',
        frontendRef: frontendSha,
        customerService: customer.serviceName,
        platformService: platform.serviceName,
      },
    }),
  });

  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  await githubApi(`/repos/${repository}/deployments/${deployment.id}/statuses`, {
    method: 'POST',
    body: JSON.stringify({
      state: 'success',
      environment,
      environment_url: config.customer,
      log_url: runUrl,
      description: 'Render Customer + Platform pair verified',
      auto_inactive: false,
    }),
  });

  console.log(`Published normalized deployment ${deployment.id} for ${environment} at ${apiSha}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
