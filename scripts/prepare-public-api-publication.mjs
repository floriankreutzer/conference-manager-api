import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const sourceDir = path.resolve(process.env.PUBLIC_API_SOURCE_DIR || 'public-api-release');
const outputDir = path.resolve(process.env.PUBLIC_API_OUTPUT_DIR || '.public-api-publication');
const sourceCommit = process.env.PUBLIC_API_SOURCE_COMMIT || '';
const contractVersion = process.env.PUBLIC_API_CONTRACT_VERSION || '';

function fail(code) {
  throw new Error(code);
}

if (!SHA.test(sourceCommit)) fail('PUBLIC_API_SOURCE_COMMIT_INVALID');
if (!VERSION.test(contractVersion)) fail('PUBLIC_API_CONTRACT_VERSION_INVALID');

const manifestPath = path.join(sourceDir, 'publication.json');
await access(manifestPath).catch(() => fail('PUBLIC_API_RELEASE_NOT_APPROVED'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.approved !== true) fail('PUBLIC_API_RELEASE_NOT_APPROVED');
if (manifest.sourceCommit !== sourceCommit) fail('PUBLIC_API_SOURCE_COMMIT_MISMATCH');
if (manifest.contractVersion !== contractVersion) fail('PUBLIC_API_CONTRACT_VERSION_MISMATCH');
if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('PUBLIC_API_ALLOWLIST_EMPTY');

const allowed = new Set(['openapi.yaml', 'openapi.yml', 'openapi.json', 'SECURITY.md', 'CHANGELOG.md']);
for (const file of manifest.files) {
  if (typeof file !== 'string' || !allowed.has(file)) fail('PUBLIC_API_FILE_NOT_ALLOWLISTED');
  if (file.includes('/') || file.includes('\\')) fail('PUBLIC_API_FILE_PATH_INVALID');
  await access(path.join(sourceDir, file)).catch(() => fail('PUBLIC_API_FILE_MISSING'));
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
for (const file of manifest.files) {
  const content = await readFile(path.join(sourceDir, file), 'utf8');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(content)) {
    fail('PUBLIC_API_SECRET_PATTERN_DETECTED');
  }
  await writeFile(path.join(outputDir, file), content, 'utf8');
}
await writeFile(path.join(outputDir, 'publication.json'), JSON.stringify({
  sourceRepository: 'floriankreutzer/conference-manager-api',
  sourceCommit,
  contractVersion,
  files: manifest.files,
}, null, 2) + '\n', 'utf8');
process.stdout.write(`Prepared approved public API publication ${contractVersion} from ${sourceCommit}.\n`);
