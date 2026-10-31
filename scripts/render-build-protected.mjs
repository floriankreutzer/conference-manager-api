import { execFileSync } from 'node:child_process';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontendPath = 'vendor/protected-frontend';
const flags = [
  'PROTECTED_SYNTHETIC_ENABLED', 'PROTECTED_PRESENTATION_MICROSOFT_ENABLED',
  'PROTECTED_PRESENTATION_INVITATIONS_ENABLED', 'PROTECTED_OWNER_CUSTOMER_ACCESS_ENABLED',
];

function reject() { throw new Error('PROTECTED_RENDER_BUILD_REFUSED'); }

function profile(env) {
  const result = {};
  for (const key of ['PROTECTED_API_COMMIT', 'PROTECTED_FRONTEND_COMMIT']) {
    if (!/^[a-f0-9]{40}$/.test(env[key] ?? '') || /^0{40}$/.test(env[key])) reject();
    result[key] = env[key];
  }
  if (env.PROTECTED_ENVIRONMENT !== 'int') reject();
  result.PROTECTED_ENVIRONMENT = 'int';
  for (const key of ['PROTECTED_CUSTOMER_ORIGIN', 'PROTECTED_PLATFORM_ORIGIN']) {
    const url = new URL(env[key]);
    if (url.protocol !== 'https:' || url.origin !== env[key] || url.username || url.password) reject();
    result[key] = url.origin;
  }
  if (result.PROTECTED_CUSTOMER_ORIGIN === result.PROTECTED_PLATFORM_ORIGIN) reject();
  for (const key of flags) {
    if (!['true', 'false'].includes(env[key])) reject();
    result[key] = env[key];
  }
  return result;
}

function environment(env, names) {
  return Object.fromEntries(names.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
}

function execute(command, args, options) {
  return execFileSync(command, args, {
    ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
}

async function checkDirectory(directory, required = false) {
  const stat = await lstat(directory).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (required && !stat) reject();
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) reject();
}

// Build-time only. The reviewed checkout's builder owns sealing and manifest validation.
// No runtime credential, input-selected executable, repository or output path is accepted.
export async function buildProtectedRender({ apiRoot = root, env = process.env, run = execute } = {}) {
  const inputs = profile(env);
  const system = environment(env, ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS']);
  const gitEnv = { ...system, GIT_TERMINAL_PROMPT: '0' };
  const git = args => run('git', args, { cwd: apiRoot, env: gitEnv }).trim();
  if (git(['rev-parse', 'HEAD']) !== inputs.PROTECTED_API_COMMIT) reject();
  if (git(['status', '--porcelain', '--untracked-files=normal'])) reject();
  // Render initializes this immutable Gitlink with its existing Git-provider
  // credentials. Refuse missing/dirty checkouts; never fall back to a public clone.
  const source = path.join(apiRoot, frontendPath);
  await checkDirectory(path.dirname(source), true);
  await checkDirectory(source, true);
  if (git(['ls-tree', 'HEAD', '--', frontendPath])
    !== `160000 commit ${inputs.PROTECTED_FRONTEND_COMMIT}\t${frontendPath}`) reject();
  if (git(['-C', source, 'rev-parse', '--show-toplevel']) !== source) reject();
  if (git(['-C', source, 'rev-parse', 'HEAD']) !== inputs.PROTECTED_FRONTEND_COMMIT) reject();
  if (git(['-C', source, 'status', '--porcelain', '--untracked-files=normal'])) reject();
  const checkout = path.join(apiRoot, '.protected-ui-build');
  const output = path.join(apiRoot, '.protected-frontend');
  await checkDirectory(checkout);
  await checkDirectory(output);
  await rm(checkout, { recursive: true, force: true });
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: apiRoot, env: system });
  run('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, env: system });
  await rm(output, { recursive: true, force: true });
  const summary = run(process.execPath, ['scripts/build-protected-frontend.mjs', output], {
    cwd: source, env: { ...environment(env, ['PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT']), ...inputs },
  });
  // The owning builder emits a public digest summary; do not echo subprocess diagnostics.
  const evidence = JSON.parse(summary);
  if (evidence.apiCommit !== inputs.PROTECTED_API_COMMIT || evidence.frontendCommit !== inputs.PROTECTED_FRONTEND_COMMIT) {
    reject();
  }
  for (const surface of ['customer', 'platform']) {
    if (!/^[a-f0-9]{64}$/.test(evidence.manifestSha256?.[surface] ?? '')) reject();
  }
  return { apiCommit: evidence.apiCommit, frontendCommit: evidence.frontendCommit,
    manifestSha256: { customer: evidence.manifestSha256.customer, platform: evidence.manifestSha256.platform } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) reject();
    console.log(JSON.stringify(await buildProtectedRender()));
  } catch {
    process.stderr.write('PROTECTED_RENDER_BUILD_REFUSED\n');
    process.exitCode = 1;
  }
}
