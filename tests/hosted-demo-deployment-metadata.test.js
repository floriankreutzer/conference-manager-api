import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHostedDemoDeploymentMetadata,
  HOSTED_DEMO_DEPLOYMENT_METADATA_PATH,
  serializeHostedDemoDeploymentMetadata,
} from '../scripts/hosted-demo-deployment-metadata.mjs';

const FRONTEND_REF = '07f2896d56e6f66a9f8daf96457ab12c763adf80';
const RUNTIME_REF = '5a9818d9e13589f1ec4f79610ac51129513e279a';

function renderEnv(overrides = {}) {
  return {
    RENDER: 'true',
    RENDER_GIT_REPO_SLUG: 'floriankreutzer/conference-manager-api',
    RENDER_GIT_BRANCH: 'main',
    RENDER_GIT_COMMIT: RUNTIME_REF,
    RENDER_SERVICE_NAME: 'conference-manager-demo',
    ...overrides,
  };
}

test('hosted deployment metadata binds the browser artifact to the actual Render build', () => {
  const metadata = createHostedDemoDeploymentMetadata(renderEnv(), FRONTEND_REF);

  assert.deepEqual(metadata, {
    schemaVersion: 1,
    provider: 'render',
    repository: 'floriankreutzer/conference-manager-api',
    branch: 'main',
    serviceName: 'conference-manager-demo',
    runtimeRef: RUNTIME_REF,
    frontendRef: FRONTEND_REF,
  });
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(HOSTED_DEMO_DEPLOYMENT_METADATA_PATH, 'assets/hosted-demo-deployment.json');
  assert.equal(
    serializeHostedDemoDeploymentMetadata(metadata),
    `${JSON.stringify(metadata)}\n`,
  );
});

test('both fixed Render Demo services are valid deployment identities', () => {
  assert.equal(
    createHostedDemoDeploymentMetadata(
      renderEnv({ RENDER_SERVICE_NAME: 'conference-manager-ops-demo' }),
      FRONTEND_REF,
    ).serviceName,
    'conference-manager-ops-demo',
  );
});

test('non-Render preparation does not claim provider deployment identity', () => {
  assert.equal(createHostedDemoDeploymentMetadata({ RENDER: 'false' }, FRONTEND_REF), null);
  assert.equal(createHostedDemoDeploymentMetadata({}, FRONTEND_REF), null);
});

test('Render deployment metadata fails closed on mutable or mismatched provider identity', () => {
  const invalid = [
    ['RENDER_GIT_REPO_SLUG', 'someone/other-repository', 'HOSTED_DEMO_RENDER_REPOSITORY_INVALID'],
    ['RENDER_GIT_BRANCH', 'feature/demo', 'HOSTED_DEMO_RENDER_BRANCH_INVALID'],
    ['RENDER_GIT_COMMIT', 'main', 'HOSTED_DEMO_RENDER_COMMIT_INVALID'],
    ['RENDER_GIT_COMMIT', 'A'.repeat(40), 'HOSTED_DEMO_RENDER_COMMIT_INVALID'],
    ['RENDER_SERVICE_NAME', 'conference-manager-demo-copy', 'HOSTED_DEMO_RENDER_SERVICE_NAME_INVALID'],
  ];
  for (const [key, value, code] of invalid) {
    assert.throws(
      () => createHostedDemoDeploymentMetadata(renderEnv({ [key]: value }), FRONTEND_REF),
      new RegExp(code),
    );
  }
  assert.throws(
    () => createHostedDemoDeploymentMetadata(renderEnv(), 'main'),
    /HOSTED_DEMO_FRONTEND_REF_INVALID/,
  );
});

test('deployment metadata serializer rejects non-object evidence', () => {
  for (const value of [null, [], 'metadata']) {
    assert.throws(
      () => serializeHostedDemoDeploymentMetadata(value),
      /HOSTED_DEMO_DEPLOYMENT_METADATA_REQUIRED/,
    );
  }
});
