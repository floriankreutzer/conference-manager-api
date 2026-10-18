import {
  DAY_MS, exactProductObject, productInstant, requireProductCondition,
} from '../../src/observability/product-delivery-contract.js';

const COMMIT = /^[a-f0-9]{40}$/;
const DEPLOYMENT_ID = /^dep-[a-z0-9]{1,70}$/;
const WEBSITE_REPOSITORY = 'floriankreutzer/conference-manager-website';
const WEBSITE_WORKFLOW = '.github/workflows/github-pages.yml';
const RENDER_STATUSES = new Set(['created', 'queued', 'build_in_progress', 'update_in_progress', 'live', 'deactivated',
  'build_failed', 'update_failed', 'canceled', 'pre_deploy_in_progress', 'pre_deploy_failed']);

function window(periodStart, periodEnd) {
  const start = productInstant(periodStart); const end = productInstant(periodEnd);
  requireProductCondition(end - start === 28 * DAY_MS && start % DAY_MS === 0);
  return { start, end };
}

function providerTime(value) {
  requireProductCondition(typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value));
  const normalized = new Date(value).toISOString();
  requireProductCondition(normalized.slice(0, 19) === value.slice(0, 19));
  return normalized;
}

function delivery(source, sourceId, component, artifactCommit, deployedAt) {
  return Object.freeze({ source, sourceId, component, artifactCommit, deployedAt,
    changes: [], outcome: 'unknown', failureAt: null, recoveredAt: null, rework: null });
}

// A live runtime deploy carries the immutable static bundle reviewed in that same source tree.
// The collector must retrieve this binding at each actual Render runtime commit, never at moving main.
export function normalizeHostedFrontendBinding({ runtimeCommit, blueprint, submodule, prepareScript, packageJson }) {
  requireProductCondition(COMMIT.test(runtimeCommit) && typeof blueprint === 'string' && blueprint.length <= 20_000
    && typeof prepareScript === 'string' && prepareScript.length <= 20_000);
  const refs = [...blueprint.matchAll(/- key: DEMO_FRONTEND_REF\s+value: ([a-f0-9]{40})(?:\s|$)/g)].map((x) => x[1]);
  requireProductCondition(refs.length === 2 && refs[0] === refs[1]
    && blueprint.includes('name: conference-manager-demo')
    && blueprint.includes('startCommand: npm run start:demo:customer')
    && blueprint.includes('buildCommand: npm ci --ignore-scripts --no-audit --no-fund && npm run demo:hosted:prepare')
    && packageJson?.scripts?.['demo:hosted:prepare'] === 'node scripts/prepare-hosted-demo-frontend.mjs');
  // An environment-driven historical fetch does not attest the effective deployed frontend ref.
  requireProductCondition(submodule?.type === 'submodule' && submodule.path === 'vendor/demo-frontend'
    && submodule.submodule_git_url === 'https://github.com/floriankreutzer/conference-manager.git'
    && submodule.sha === refs[0]
    && prepareScript.includes("const SOURCE_DIRECTORY = path.resolve(process.cwd(), 'vendor/demo-frontend');")
    && prepareScript.includes("['-C', SOURCE_DIRECTORY, 'rev-parse', 'HEAD']")
    && prepareScript.includes("if (stdout.trim() !== frontendRef) throw new Error('DEMO_FRONTEND_REF_MISMATCH');")
    && prepareScript.includes('await cp(SOURCE_DIRECTORY, TARGET_DIRECTORY,'));
  return Object.freeze({ runtimeCommit, frontendCommit: refs[0] });
}

export function normalizeRenderDelivery({ records, periodStart, periodEnd, sourceComplete, frontendBindings }) {
  const { start, end } = window(periodStart, periodEnd);
  requireProductCondition(Array.isArray(records) && records.length <= 2000 && typeof sourceComplete === 'boolean'
    && Array.isArray(frontendBindings) && frontendBindings.length <= 2000);
  const bindings = new Map();
  for (const item of frontendBindings) {
    exactProductObject(item, ['runtimeCommit', 'frontendCommit']);
    requireProductCondition(COMMIT.test(item.runtimeCommit) && COMMIT.test(item.frontendCommit)
      && !bindings.has(item.runtimeCommit));
    bindings.set(item.runtimeCommit, item.frontendCommit);
  }
  const deployments = []; const ids = new Set();
  let apiComplete = sourceComplete; let applicationComplete = sourceComplete;
  for (const record of records) {
    try {
      requireProductCondition(DEPLOYMENT_ID.test(record?.id) && !ids.has(record.id) && RENDER_STATUSES.has(record.status));
      ids.add(record.id);
      if (!['live', 'deactivated'].includes(record.status)) continue;
      const deployedAt = providerTime(record.finishedAt);
      const deployed = productInstant(deployedAt);
      if (deployed < start || deployed >= end) continue;
      requireProductCondition(COMMIT.test(record.commit?.id));
      deployments.push(delivery('render', record.id, 'api', record.commit.id, deployedAt));
      const frontend = bindings.get(record.commit.id);
      if (!frontend) applicationComplete = false;
      else deployments.push(delivery('render', `${record.id}:application`, 'application', frontend, deployedAt));
    } catch {
      apiComplete = false; applicationComplete = false;
    }
  }
  requireProductCondition(deployments.length <= 2000);
  return Object.freeze({ deployments: Object.freeze(deployments), apiComplete, applicationComplete });
}

function successful(value) {
  return value?.status === 'completed' && value.conclusion === 'success';
}

// A specific provider-confirmed Pages publish step is evidence; a green workflow/build is not.
export function normalizeWebsiteDeployment({ run, job, workflowSource, jobLog, periodStart, periodEnd }) {
  const { start, end } = window(periodStart, periodEnd);
  requireProductCondition(run?.repository?.full_name === WEBSITE_REPOSITORY && run.path === WEBSITE_WORKFLOW
    && run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event)
    && Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt >= 1
    && COMMIT.test(run.head_sha) && Number.isSafeInteger(job?.id) && job.id > 0
    && job.run_id === run.id && job.head_sha === run.head_sha && job.status === 'completed'
    && Number.isSafeInteger(job.run_attempt) && job.run_attempt >= 1 && job.run_attempt <= run.run_attempt
    && job.name === 'deploy' && Array.isArray(job.steps) && job.steps.length <= 30);
  requireProductCondition(typeof workflowSource === 'string' && workflowSource.length <= 20_000
    && workflowSource.includes('PUBLIC_BASE_PATH: /conference-manager-website/')
    && workflowSource.includes('name: github-pages')
    && workflowSource.includes('name: Deploy GitHub Pages review site')
    && workflowSource.includes('uses: actions/deploy-pages@v4')
    && !workflowSource.includes('continue-on-error: true'));
  const steps = job.steps.filter((item) => item.name === 'Deploy GitHub Pages review site');
  requireProductCondition(steps.length === 1);
  const step = steps[0];
  if (!successful(step)) return null;
  requireProductCondition(typeof jobLog === 'string' && jobLog.length <= 256_000);
  const created = [...jobLog.matchAll(/Created deployment for ([a-f0-9]{40}), ID: ([a-f0-9]{40})/g)];
  const successes = [...jobLog.matchAll(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) Reported success!\r?$/gm)];
  requireProductCondition(created.length === 1 && created[0][1] === run.head_sha && created[0][2] === run.head_sha
    && successes.length === 1 && jobLog.includes('Run actions/deploy-pages@v4'));
  const deployedAt = providerTime(successes[0][1]); const deployed = productInstant(deployedAt);
  requireProductCondition(deployed >= productInstant(providerTime(step.started_at))
    && deployed <= productInstant(providerTime(step.completed_at)) + 1000
    && deployed <= productInstant(providerTime(job.completed_at)) + 1000
    && productInstant(providerTime(step.completed_at)) <= productInstant(providerTime(job.completed_at)) + 1000);
  if (deployed < start || deployed >= end) return null;
  return delivery('github_pages', `pages-job:${job.id}`, 'website', run.head_sha, deployedAt);
}
