import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeHostedFrontendBinding, normalizeRenderDelivery, normalizeWebsiteDeployment,
} from '../scripts/support/delivery-source-normalizer.mjs';
import { compileProductDeliveryReport } from '../src/observability/product-delivery-report.js';

const COMMIT = 'a'.repeat(40); const FRONTEND = 'b'.repeat(40);
const WINDOW = { periodStart: '2026-09-20T00:00:00.000Z', periodEnd: '2026-10-18T00:00:00.000Z' };
const record = { id: 'dep-synthetic1', status: 'deactivated', commit: { id: COMMIT },
  finishedAt: '2026-10-17T12:00:00.123456Z' };

test('API and bundled application histories require their own immutable source binding', async () => {
  const blueprint = (await readFile('render.yaml', 'utf8')).replaceAll(/[a-f0-9]{40}/g, FRONTEND);
  const source = { runtimeCommit: COMMIT, blueprint, submodule: { type: 'submodule', path: 'vendor/demo-frontend',
    submodule_git_url: 'https://github.com/floriankreutzer/conference-manager.git', sha: FRONTEND },
  prepareScript: await readFile('scripts/prepare-hosted-demo-frontend.mjs', 'utf8'),
  packageJson: JSON.parse(await readFile('package.json', 'utf8')) };
  const binding = normalizeHostedFrontendBinding(source);
  assert.deepEqual(binding, { runtimeCommit: COMMIT, frontendCommit: FRONTEND });
  const result = normalizeRenderDelivery({ records: [record, { ...record, id: 'dep-failed', status: 'build_failed' }],
    ...WINDOW, sourceComplete: true, frontendBindings: [binding] });
  assert.equal(result.apiComplete, true); assert.equal(result.applicationComplete, true);
  assert.equal(result.deployments.length, 2);
  assert.deepEqual(result.deployments.map((x) => [x.component, x.artifactCommit, x.deployedAt]), [
    ['api', COMMIT, '2026-10-17T12:00:00.123Z'], ['application', FRONTEND, '2026-10-17T12:00:00.123Z'],
  ]);
  assert.ok(result.deployments.every((x) => x.outcome === 'unknown' && x.rework === null && x.changes.length === 0));
  for (const mutate of [(x) => { x.submodule.sha = COMMIT; },
    (x) => { x.prepareScript = 'copy an arbitrary unverified frontend'; },
    (x) => { x.packageJson.scripts['demo:hosted:prepare'] = 'node other.mjs'; },
    (x) => { x.submodule.submodule_git_url = 'https://untrusted.invalid/repo'; }]) {
    const altered = structuredClone(source); mutate(altered);
    assert.throws(() => normalizeHostedFrontendBinding(altered));
  }
});

test('missing frontend proof does not erase API evidence or claim complete application history', () => {
  const result = normalizeRenderDelivery({ records: [record], ...WINDOW, sourceComplete: true, frontendBindings: [] });
  assert.equal(result.apiComplete, true); assert.equal(result.applicationComplete, false);
  assert.equal(result.deployments.length, 1);
  const duplicate = normalizeRenderDelivery({ records: [record, record], ...WINDOW,
    sourceComplete: true, frontendBindings: [] });
  assert.equal(duplicate.apiComplete, false);
  for (const change of [{ status: 'provider-new-status' }, { finishedAt: 'not-a-clock' }, { commit: { id: 'main' } }]) {
    const invalid = normalizeRenderDelivery({ records: [{ ...record, ...change }], ...WINDOW,
      sourceComplete: true, frontendBindings: [] });
    assert.equal(invalid.apiComplete, false); assert.equal(invalid.applicationComplete, false);
  }
  assert.equal(normalizeRenderDelivery({ records: [], ...WINDOW, sourceComplete: false, frontendBindings: [] }).apiComplete, false);
});

test('the historical immutable-fetch builder cannot attest a deployed frontend without a Gitlink', async () => {
  const source = { runtimeCommit: COMMIT, submodule: null,
    blueprint: (await readFile('render.yaml', 'utf8')).replaceAll(/[a-f0-9]{40}/g, FRONTEND),
    prepareScript: await readFile('tests/fixtures/hosted-demo-legacy-prepare.txt', 'utf8'),
    packageJson: JSON.parse(await readFile('package.json', 'utf8')) };
  assert.throws(() => normalizeHostedFrontendBinding(source));
});

function website() {
  return { ...WINDOW,
    run: { id: 701, run_attempt: 1, repository: { full_name: 'floriankreutzer/conference-manager-website' },
      path: '.github/workflows/github-pages.yml', event: 'push', head_branch: 'main', head_sha: COMMIT },
    job: { id: 901, run_id: 701, run_attempt: 1, head_sha: COMMIT, name: 'deploy', status: 'completed',
      conclusion: 'success', completed_at: '2026-10-17T12:00:03Z', steps: [
        { name: 'Deploy GitHub Pages review site', status: 'completed', conclusion: 'success',
          started_at: '2026-10-17T11:59:00Z', completed_at: '2026-10-17T12:00:02Z' },
      ] },
    workflowSource: 'PUBLIC_BASE_PATH: /conference-manager-website/\nname: github-pages\n'
      + 'name: Deploy GitHub Pages review site\nuses: actions/deploy-pages@v4\n',
    jobLog: '2026-10-17T11:59:00.0000000Z Run actions/deploy-pages@v4\n'
      + `2026-10-17T11:59:01.0000000Z Created deployment for ${COMMIT}, ID: ${COMMIT}\n`
      + '2026-10-17T12:00:02.1234567Z Reported success!\n',
  };
}

test('Website frequency counts a provider-confirmed Pages deploy receipt and remains unknown for CI-only success', () => {
  const source = website(); const actual = normalizeWebsiteDeployment(source);
  assert.deepEqual(actual, { source: 'github_pages', sourceId: 'pages-job:901', component: 'website',
    artifactCommit: COMMIT, deployedAt: '2026-10-17T12:00:02.123Z', changes: [], outcome: 'unknown',
    failureAt: null, recoveredAt: null, rework: null });
  for (const mutate of [(x) => { x.jobLog = 'green workflow'; },
    (x) => { x.jobLog = x.jobLog.replaceAll(COMMIT, FRONTEND); },
    (x) => { x.run.path = '.github/workflows/ci.yml'; },
    (x) => { x.job.run_id = 999; }, (x) => { x.job.head_sha = FRONTEND; },
    (x) => { x.workflowSource += '\ncontinue-on-error: true'; },
    (x) => { x.run.repository.full_name = 'other/website'; },
    (x) => { x.run.head_branch = 'unreviewed'; },
    (x) => { x.jobLog += '2026-10-17T12:00:02.2000000Z Reported success!\n'; }]) {
    const altered = website(); mutate(altered);
    assert.throws(() => normalizeWebsiteDeployment(altered));
  }
  source.job.steps[0].conclusion = 'failure';
  assert.equal(normalizeWebsiteDeployment(source), null);
});

test('a Pages success receipt cannot follow the deploy step beyond its timestamp precision', () => {
  const source = website();
  source.job.completed_at = '2026-10-17T12:05:00Z';
  source.jobLog = source.jobLog.replace('2026-10-17T12:00:02.1234567Z Reported success!',
    '2026-10-17T12:00:03.5000000Z Reported success!');
  assert.throws(() => normalizeWebsiteDeployment(source));
});

test('all three target frequencies compile without inventing healthy changes, recovery or rework', () => {
  const render = normalizeRenderDelivery({ records: [record], ...WINDOW, sourceComplete: true,
    frontendBindings: [{ runtimeCommit: COMMIT, frontendCommit: FRONTEND }] });
  const report = compileProductDeliveryReport({ schemaVersion: 1, environment: 'demo', ...WINDOW,
    observedAt: '2026-10-18T12:00:00.000Z', productComplete: false, productEvents: [],
    deliveryComplete: { application: render.applicationComplete, api: render.apiComplete, website: true },
    deployments: [...render.deployments, normalizeWebsiteDeployment(website())],
    feedbackSource: 'not_configured', feedbackComplete: false, feedback: [] });
  for (const component of report.delivery) {
    assert.equal(component.buckets.at(-1).metrics.find((x) => x.id === 'deployment_frequency').value, 1);
    assert.ok(component.buckets.at(-1).metrics.filter((x) => x.id !== 'deployment_frequency').every((x) => x.value === null));
  }
});
