import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);

test('metadata events retain all gates without cancelling source validation or independent Main runs', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /types: \[opened, synchronize, reopened, edited, ready_for_review\]/);
  assert.ok(workflow.includes(
    "group: ci-${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}",
  ));
  assert.ok(workflow.includes(
    "cancel-in-progress: ${{ github.event_name == 'pull_request' && github.event.action != 'edited' "
      + "&& github.event.action != 'ready_for_review' }}",
  ));
  assert.match(workflow, /Require matching Jira key in PR title and branch/);
  assert.match(workflow, /run: npm run check/);
  assert.doesNotMatch(workflow, /if:.*github\.event\.action/);
});

test('CI uses the supported App identifier input without changing credential custody or grants', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const tokenPattern = /uses: actions\/create-github-app-token@([a-f0-9]{40})[^\n]*\n        with:\n([\s\S]*?)(?=\n      - name:)/g;
  const tokenSteps = [...workflow.matchAll(tokenPattern)];
  assert.equal(tokenSteps.length, 2);
  for (const [, pin, inputs] of tokenSteps) {
    assert.equal(pin, '64ab729a6294000f5aa4a4bc0b73d1f32bc45510');
    assert.match(inputs, /client-id: \$\{\{ secrets\.CM_CI_READER_APP_ID \}\}/);
    assert.match(inputs, /private-key: \$\{\{ secrets\.CM_CI_READER_PRIVATE_KEY \}\}/);
    assert.match(inputs, /owner: floriankreutzer/);
    assert.doesNotMatch(inputs, /app-id:|skip-token-revoke:|permission-[a-z-]+: write/);
    assert.equal((inputs.match(/permission-/g) ?? []).length, 1);
  }
});

test('CI uses the read-only job token when the optional source App is unavailable', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.equal((workflow.match(/if: env\.HAS_SOURCE_APP == 'true'/g) ?? []).length, 2);
  const appAvailability = "HAS_SOURCE_APP: ${{ secrets.CM_CI_READER_APP_ID != '' "
    + "|| secrets.CM_CI_READER_PRIVATE_KEY != '' }}";
  assert.equal(workflow.split(appAvailability).length - 1, 2);
  assert.equal((workflow.match(/token: \$\{\{ steps\.source-token\.outputs\.token \|\| github\.token \}\}/g) ?? []).length, 3);
  const scopedRepositories = 'repositories: |\n            conference-manager\n'
    + '            conference-manager-api\n          permission-contents: read';
  assert.equal(workflow.split(scopedRepositories).length - 1, 2);
  assert.ok(workflow.includes(
    'token: ${{ steps.source-token.outputs.token || github.token }}\n'
    + '          submodules: true\n          persist-credentials: false',
  ));
  assert.doesNotMatch(workflow, /continue-on-error:|pull_request_target:/);
  assert.doesNotMatch(workflow, /name: Checkout(?: API| immutable frontend commit| immutable permanent acceptance contract)?\s+if:/);
});

test('CI retains immutable cross-repository sources and every permanent Demo matrix row', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const pinnedCheckouts = [...workflow.matchAll(/repository: floriankreutzer\/conference-manager\s+ref: ([a-f0-9]{40})/g)];
  assert.equal(pinnedCheckouts.length, 2);
  for (const [, ref] of pinnedCheckouts) assert.doesNotMatch(ref, /^(?:0{40}|f{40})$/);
  assert.equal((workflow.match(/media_storage: postgres/g) ?? []).length, 2);
  assert.equal((workflow.match(/media_storage: objects/g) ?? []).length, 2);
  assert.match(workflow, /run: npm run test:db/);
  assert.match(workflow, /run: npm run test:e2e:shared-demo/);
  assert.match(workflow, /run: npm run test:e2e:saas37/);
  assert.match(workflow, /Frontend checkout does not match the immutable deployed ref/);
  assert.match(workflow, /Acceptance checkout does not match the immutable acceptance ref/);
});
