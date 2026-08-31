import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createAnonymousGitEnvironment } from './hosted-demo-git-environment.mjs';

const execFileAsync = promisify(execFile);
const FRONTEND_REPOSITORY = 'https://github.com/floriankreutzer/conference-manager.git';
const FRONTEND_REF_PATTERN = /^[0-9a-f]{40}$/;
const TARGET_DIRECTORY = path.resolve(process.cwd(), '.demo-frontend');
const GIT_HOME_PREFIX = path.join(tmpdir(), 'conference-manager-demo-git-');
const REQUIRED_FILES = Object.freeze([
  'index.html',
  'platform-admin-demo/index.html',
  'src/platform/demo-bootstrap.js',
  'src/platform-admin/demo/bootstrap.js',
  'assets/tokens.css',
]);

function requiredRef(env) {
  const value = env.DEMO_FRONTEND_REF;
  if (typeof value !== 'string' || !FRONTEND_REF_PATTERN.test(value)) {
    throw new Error('DEMO_FRONTEND_REF_INVALID');
  }
  return value;
}

async function git(environment, ...args) {
  return execFileAsync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1_048_576,
    windowsHide: true,
  });
}

async function assertFrontendContract(root) {
  for (const relativePath of REQUIRED_FILES) await access(path.join(root, relativePath));
  const customerHtml = await readFile(path.join(root, 'index.html'), 'utf8');
  const platformHtml = await readFile(path.join(root, 'platform-admin-demo/index.html'), 'utf8');
  if (
    !customerHtml.includes('conference-demo-data" content="synthetic-server-backed"')
    || !customerHtml.includes('src/platform/demo-bootstrap.js')
  ) throw new Error('DEMO_CUSTOMER_FRONTEND_CONTRACT_INVALID');
  if (
    !platformHtml.includes('platform-demo-data" content="synthetic-server-backed"')
    || !platformHtml.includes('src/platform-admin/demo/bootstrap.js')
  ) throw new Error('DEMO_PLATFORM_FRONTEND_CONTRACT_INVALID');
}

const frontendRef = requiredRef(process.env);
await rm(TARGET_DIRECTORY, { recursive: true, force: true });
const gitHome = await mkdtemp(GIT_HOME_PREFIX);
const gitEnvironment = createAnonymousGitEnvironment(process.env, gitHome);
try {
  await git(gitEnvironment, 'init', '--quiet', TARGET_DIRECTORY);
  await git(gitEnvironment, '-C', TARGET_DIRECTORY, 'remote', 'add', 'origin', FRONTEND_REPOSITORY);
  await git(gitEnvironment, '-C', TARGET_DIRECTORY, 'fetch', '--quiet', '--depth=1', 'origin', frontendRef);
  await git(gitEnvironment, '-C', TARGET_DIRECTORY, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  const { stdout } = await git(gitEnvironment, '-C', TARGET_DIRECTORY, 'rev-parse', 'HEAD');
  if (stdout.trim() !== frontendRef) throw new Error('DEMO_FRONTEND_REF_MISMATCH');
  await assertFrontendContract(TARGET_DIRECTORY);
  await rm(path.join(TARGET_DIRECTORY, '.git'), { recursive: true, force: true });
  process.stdout.write(`Prepared immutable Demo frontend ${frontendRef}.\n`);
} finally {
  await rm(gitHome, { recursive: true, force: true });
}
