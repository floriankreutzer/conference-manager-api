import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const sourceDir = path.resolve(process.env.PUBLIC_API_SOURCE_DIR || 'public-api-release');
const outputDir = path.resolve(process.env.PUBLIC_API_OUTPUT_DIR || '.public-api-publication');
const contractVersion = process.env.PUBLIC_API_CONTRACT_VERSION || '';

function fail(code) {
  throw new Error(code);
}

function digest(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function assertPublicOpenApi(content) {
  if (/\b(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)\b/i.test(content)) {
    fail('PUBLIC_API_PRIVATE_DESTINATION_DETECTED');
  }
  if (/\b(?:internal|private)[-_ ]?(?:endpoint|schema|service|host)\b/i.test(content)) {
    fail('PUBLIC_API_INTERNAL_CONTRACT_MARKER_DETECTED');
  }
  if (/https?:\/\/[^\s"'<>]*(?:\.internal|\.local)(?:[/:]|$)/i.test(content)) {
    fail('PUBLIC_API_PRIVATE_DESTINATION_DETECTED');
  }
}

if (!VERSION.test(contractVersion)) fail('PUBLIC_API_CONTRACT_VERSION_INVALID');

const manifestPath = path.join(sourceDir, 'publication.json');
await access(manifestPath).catch(() => fail('PUBLIC_API_RELEASE_NOT_APPROVED'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.approved !== true) fail('PUBLIC_API_RELEASE_NOT_APPROVED');
if (manifest.contractVersion !== contractVersion) fail('PUBLIC_API_CONTRACT_VERSION_MISMATCH');
if (!DIGEST.test(manifest.artifactDigest || '')) fail('PUBLIC_API_ARTIFACT_DIGEST_INVALID');
if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('PUBLIC_API_ALLOWLIST_EMPTY');

const allowed = new Set(['openapi.yaml', 'openapi.yml', 'openapi.json', 'SECURITY.md', 'CHANGELOG.md']);
const staged = [];
for (const file of manifest.files) {
  if (typeof file !== 'string' || !allowed.has(file)) fail('PUBLIC_API_FILE_NOT_ALLOWLISTED');
  if (file.includes('/') || file.includes('\\')) fail('PUBLIC_API_FILE_PATH_INVALID');
  const filePath = path.join(sourceDir, file);
  await access(filePath).catch(() => fail('PUBLIC_API_FILE_MISSING'));
  const content = await readFile(filePath, 'utf8');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(content)) {
    fail('PUBLIC_API_SECRET_PATTERN_DETECTED');
  }
  if (/^openapi\.(?:ya?ml|json)$/.test(file)) assertPublicOpenApi(content);
  staged.push([file, content]);
}

const canonical = staged
  .slice()
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([file, content]) => `${file}\0${content}\0`)
  .join('');
if (digest(canonical) !== manifest.artifactDigest) fail('PUBLIC_API_ARTIFACT_DIGEST_MISMATCH');

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
for (const [file, content] of staged) await writeFile(path.join(outputDir, file), content, 'utf8');
await writeFile(
  path.join(outputDir, 'publication.json'),
  JSON.stringify({
    sourceRepository: 'floriankreutzer/conference-manager-api',
    artifactDigest: manifest.artifactDigest,
    contractVersion,
    files: manifest.files,
  }, null, 2) + '\n',
  'utf8',
);
process.stdout.write(`Prepared approved public API publication ${contractVersion} (${manifest.artifactDigest}).\n`);
