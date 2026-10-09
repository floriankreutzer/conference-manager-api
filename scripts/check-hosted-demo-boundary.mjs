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
  'node:crypto',
  'node:util',
  'node:zlib',
]);
const FORBIDDEN_ADAPTER_PATTERN = new RegExp([
  'process\\.env',
  'child_process',
  '\\bvm\\b',
  '\\bpg\\b',
  'localStorage',
  'sessionStorage',
  'https?:\\/\\/',
].join('|'), 'i');
const FORBIDDEN_LOADER_PATTERN = new RegExp([
  'process\\.env',
  'https?:\\/\\/',
  'GITHUB_TOKEN',
  'SHARED_DEMO_API_READ_TOKEN',
].join('|'));

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
    throw new Error(`${file} is an unreviewed .mjs runtime module.`);
  }
}
for (const required of APPROVED_RUNTIME_MJS) {
  if (!runtimeMjs.includes(required)) {
    throw new Error(`Approved hosted Demo module is missing: ${required}.`);
  }
}

const adapter = await readFile('src/demo/static-file-adapter.mjs', 'utf8');
const adapterImports = importsOf(adapter);
if (
  adapterImports.length !== APPROVED_STATIC_ADAPTER_IMPORTS.size
  || adapterImports.some((specifier) => !APPROVED_STATIC_ADAPTER_IMPORTS.has(specifier))
) {
  throw new Error('Hosted Demo file adapter imports are outside the reviewed allowlist.');
}
for (const required of [
  'realpath(resolvedRoot)',
  'realpath(candidate)',
  'fileStat.isFile()',
  'pipeline(createReadStream(file.path), response)',
  'approvedFiles.has(file)',
  'size > MAX_FILE_BYTES',
  'MAX_ACTIVE_REPRESENTATIONS = 8',
  'active < MAX_ACTIVE_REPRESENTATIONS',
  'MAX_QUEUED_REPRESENTATIONS = 64',
  'waiting.length >= MAX_QUEUED_REPRESENTATIONS',
  'REPRESENTATION_WAIT_MS = 5_000',
  '}, REPRESENTATION_WAIT_MS)',
  'clearTimeout(next.timer)',
  'finally { releaseRepresentationSlot(); }',
  'cache.size >= MAX_CACHE_ENTRIES',
  'cacheBytes + bytes.length > MAX_CACHE_BYTES',
  '[constants.BROTLI_PARAM_QUALITY]: 4',
]) {
  if (!adapter.includes(required)) {
    throw new Error(`Hosted Demo file adapter lacks boundary ${required}.`);
  }
}
if (FORBIDDEN_ADAPTER_PATTERN.test(adapter)) {
  throw new Error('Hosted Demo file adapter has forbidden runtime authority.');
}
if (/\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(adapter)) {
  throw new Error('Hosted Demo file adapter must not contain SQL.');
}

const loader = await readFile('src/demo/static-file-loader.js', 'utf8');
const conditionalTransport = await readFile('src/transport/conditional-get.js', 'utf8');
if (/\b(?:import|require|process|globalThis|fetch|eval)\b|https?:\/\//.test(conditionalTransport)) {
  throw new Error('Shared conditional transport must remain import-free and authority-free.');
}
for (const required of [
  "STATIC_FILE_ADAPTER_MODULE = './static-file-adapter.mjs'",
  'await import(STATIC_FILE_ADAPTER_MODULE)',
  'module.createDemoStaticFileAdapter({ root })',
]) {
  if (!loader.includes(required)) {
    throw new Error(`Hosted Demo adapter loader lacks boundary ${required}.`);
  }
}
if (FORBIDDEN_LOADER_PATTERN.test(loader)) {
  throw new Error('Hosted Demo adapter loader has forbidden runtime authority.');
}

const handler = await readFile('src/demo/static-handler.js', 'utf8');
for (const required of [
  'DEMO_STATIC_FILE_ADAPTER_REQUIRED',
  "pathname.startsWith('/assets/')",
  "pathname.startsWith('/src/')",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "'Cross-Origin-Embedder-Policy', 'require-corp'",
  "['GET', 'HEAD']",
  "file?.kind === 'invalid'",
]) {
  if (!handler.includes(required)) {
    throw new Error(`Hosted Demo static transport lacks boundary ${required}.`);
  }
}
const handlerImportsPrivilegedModule = /from ['"](?:node:)?(?:fs|child_process|vm)/.test(handler);
const handlerImportsAdapter = /static-file-adapter\.mjs/.test(handler);
if (handlerImportsPrivilegedModule || handlerImportsAdapter) {
  throw new Error('Hosted Demo static transport bypasses its injected file port.');
}
if (/https?:\/\//.test(handler)) {
  throw new Error('Hosted Demo static transport must not contain outbound URLs.');
}

for (const file of ['src/demo/customer-main.js', 'src/demo/platform-main.js']) {
  const source = await readFile(file, 'utf8');
  for (const required of [
    'loadDemoStaticFileAdapter',
    'config.staticRoot',
    'staticFileAdapter',
  ]) {
    if (!source.includes(required)) {
      throw new Error(`${file} lacks hosted Demo injection ${required}.`);
    }
  }
}
for (const file of ['src/demo/customer-composition.js', 'src/demo/platform-composition.js']) {
  const source = await readFile(file, 'utf8');
  for (const required of [
    'staticFileAdapter = null',
    'config.staticRoot && !staticFileAdapter',
    'staticFileAdapter,',
  ]) {
    if (!source.includes(required)) {
      throw new Error(`${file} lacks hosted Demo composition ${required}.`);
    }
  }
}
for (const file of ['src/demo/customer-server.js', 'src/demo/platform-server.js']) {
  const source = await readFile(file, 'utf8');
  for (const required of [
    'createDemoStaticHandler',
    'config.staticRoot',
    'fileAdapter: staticFileAdapter',
    "!path?.startsWith('/api/')",
  ]) {
    if (!source.includes(required)) {
      throw new Error(`${file} lacks hosted same-origin boundary ${required}.`);
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
    throw new Error(`Hosted Demo Render Blueprint lacks ${required}.`);
  }
}
for (const forbidden of [
  'DEMO_MIGRATION_DATABASE_URL',
  'preDeployCommand:',
  'runtime: static',
  'CORS',
]) {
  if (blueprint.includes(forbidden)) {
    throw new Error(`Hosted Demo Render Blueprint contains ${forbidden}.`);
  }
}

const gitmodules = await readFile('.gitmodules', 'utf8');
for (const required of [
  '[submodule "vendor/demo-frontend"]',
  'path = vendor/demo-frontend',
  'url = https://github.com/floriankreutzer/conference-manager.git',
]) {
  if (!gitmodules.includes(required)) {
    throw new Error(`Hosted Demo frontend submodule lacks ${required}.`);
  }
}

const prepare = await readFile('scripts/prepare-hosted-demo-frontend.mjs', 'utf8');
for (const required of [
  'FRONTEND_REF_PATTERN = /^[0-9a-f]{40}$/',
  "SOURCE_DIRECTORY = path.resolve(process.cwd(), 'vendor/demo-frontend')",
  "['-C', SOURCE_DIRECTORY, 'rev-parse', 'HEAD']",
  "stdout.trim() !== frontendRef",
  'await cp(SOURCE_DIRECTORY, TARGET_DIRECTORY',
  "source !== path.join(SOURCE_DIRECTORY, '.git')",
]) {
  if (!prepare.includes(required)) {
    throw new Error(`Hosted Demo frontend preparation lacks ${required}.`);
  }
}
if (/\bshell\s*:\s*true\b|GITHUB_TOKEN|SHARED_DEMO_API_READ_TOKEN|\bgit\([^)]*fetch/.test(prepare)) {
  throw new Error('Hosted Demo frontend preparation uses forbidden checkout authority.');
}

console.log('Hosted Demo deployment/filesystem architecture boundary check passed.');
