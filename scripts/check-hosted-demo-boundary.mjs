import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const APPROVED_RUNTIME_MJS = new Set([
  'src/demo/static-file-adapter.mjs',
]);
const APPROVED_STATIC_ADAPTER_IMPORTS = new Set([
  'node:fs',
  'node:fs/promises',
  'node:path',
  'node:stream/promises',
]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(current));
    else if (entry.name.endsWith('.mjs')) files.push(current.replaceAll('\\', '/'));
  }
  return files;
}

function importsOf(source) {
  return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

const runtimeMjs = await filesUnder('src');
for (const file of runtimeMjs) {
  if (!APPROVED_RUNTIME_MJS.has(file)) {
    throw new Error(`${file} is an unreviewed .mjs runtime module outside the normal src/*.js architecture scan.`);
  }
}
for (const required of APPROVED_RUNTIME_MJS) {
  if (!runtimeMjs.includes(required)) {
    throw new Error(`Approved hosted Demo infrastructure module is missing: ${required}.`);
  }
}

const adapter = await readFile('src/demo/static-file-adapter.mjs', 'utf8');
const adapterImports = importsOf(adapter);
if (
  adapterImports.length !== APPROVED_STATIC_ADAPTER_IMPORTS.size
  || adapterImports.some((specifier) => !APPROVED_STATIC_ADAPTER_IMPORTS.has(specifier))
) {
  throw new Error('Hosted Demo static file adapter may import only the reviewed read-only Node filesystem/path/stream modules.');
}
for (const required of [
  'realpath(resolvedRoot)',
  'realpath(candidate)',
  'fileStat.isFile()',
  'pipeline(createReadStream(file.path), response)',
]) {
  if (!adapter.includes(required)) {
    throw new Error(`Hosted Demo static file adapter is missing fail-closed boundary ${required}.`);
  }
}
if (/process\.env|child_process|\bvm\b|\bpg\b|localStorage|sessionStorage|https?:\/\//i.test(adapter)) {
  throw new Error('Hosted Demo static file adapter must remain read-only filesystem infrastructure without environment, provider, database, browser-storage or outbound-network authority.');
}
if (/\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(adapter)) {
  throw new Error('Hosted Demo static file adapter must not contain SQL.');
}

const handler = await readFile('src/demo/static-handler.js', 'utf8');
for (const required of [
  "from './static-file-adapter.mjs'",
  "pathname.startsWith('/assets/')",
  "pathname.startsWith('/src/')",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "['GET', 'HEAD']",
  "file?.kind === 'invalid'",
]) {
  if (!handler.includes(required)) {
    throw new Error(`Hosted Demo static transport is missing boundary ${required}.`);
  }
}
if (/from ['"](?:node:)?(?:fs|child_process|vm)/.test(handler)) {
  throw new Error('Hosted Demo static transport must delegate privileged filesystem I/O to the reviewed adapter.');
}
if (/https?:\/\//.test(handler)) {
  throw new Error('Hosted Demo static transport must not contain outbound URLs.');
}

for (const file of ['src/demo/customer-server.js', 'src/demo/platform-server.js']) {
  const source = await readFile(file, 'utf8');
  for (const required of [
    'createDemoStaticHandler',
    'config.staticRoot',
    "!path?.startsWith('/api/')",
  ]) {
    if (!source.includes(required)) {
      throw new Error(`${file} is missing hosted same-origin boundary ${required}.`);
    }
  }
}

const blueprint = await readFile('render.yaml', 'utf8');
for (const required of [
  'name: conference-manager-demo',
  'name: conference-manager-ops-demo',
  'plan: free',
  'region: frankfurt',
  'branch: main',
  'autoDeployTrigger: off',
  'DEMO_LISTEN_HOST',
  'value: 0.0.0.0',
  'DEMO_STATIC_ROOT',
  'DEMO_CUSTOMER_DATABASE_URL',
  'DEMO_PLATFORM_DATABASE_URL',
  'DEMO_RESET_DATABASE_URL',
]) {
  if (!blueprint.includes(required)) {
    throw new Error(`Hosted Demo Render Blueprint is missing required boundary ${required}.`);
  }
}
for (const forbidden of [
  'DEMO_MIGRATION_DATABASE_URL',
  'preDeployCommand:',
  'runtime: static',
  'CORS',
]) {
  if (blueprint.includes(forbidden)) {
    throw new Error(`Hosted Demo Render Blueprint contains forbidden deployment authority ${forbidden}.`);
  }
}

const prepare = await readFile('scripts/prepare-hosted-demo-frontend.mjs', 'utf8');
for (const required of [
  'FRONTEND_REF_PATTERN = /^[0-9a-f]{40}$/',
  "git('init', '--quiet', TARGET_DIRECTORY)",
  "'FETCH_HEAD'",
  "stdout.trim() !== frontendRef",
  "rm(path.join(TARGET_DIRECTORY, '.git')",
]) {
  if (!prepare.includes(required)) {
    throw new Error(`Hosted Demo immutable frontend preparation is missing ${required}.`);
  }
}
if (/\bshell\s*:\s*true\b|GITHUB_TOKEN|SHARED_DEMO_API_READ_TOKEN/.test(prepare)) {
  throw new Error('Hosted Demo frontend preparation must not depend on shell interpolation or checkout credentials.');
}

console.log('Hosted Demo deployment/filesystem architecture boundary check passed.');
