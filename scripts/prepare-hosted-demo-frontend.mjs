import { execFile } from 'node:child_process';
import { access, cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fingerprintDemoAssets } from './fingerprint-demo-assets.mjs';

import {
  createHostedDemoDeploymentMetadata,
  HOSTED_DEMO_DEPLOYMENT_METADATA_PATH,
  serializeHostedDemoDeploymentMetadata,
} from './hosted-demo-deployment-metadata.mjs';

const execFileAsync = promisify(execFile);
const FRONTEND_REF_PATTERN = /^[0-9a-f]{40}$/;
const SOURCE_DIRECTORY = path.resolve(process.cwd(), 'vendor/demo-frontend');
const TARGET_DIRECTORY = path.resolve(process.cwd(), '.demo-frontend');
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

async function writeDeploymentMetadata(root, env, frontendRef) {
  const metadata = createHostedDemoDeploymentMetadata(env, frontendRef);
  if (!metadata) return;
  await writeFile(
    path.join(root, HOSTED_DEMO_DEPLOYMENT_METADATA_PATH),
    serializeHostedDemoDeploymentMetadata(metadata),
    { encoding: 'utf8', flag: 'w' },
  );
}

const frontendRef = requiredRef(process.env);
await access(SOURCE_DIRECTORY);
const { stdout } = await execFileAsync('git', ['-C', SOURCE_DIRECTORY, 'rev-parse', 'HEAD'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 1_048_576,
  windowsHide: true,
});
if (stdout.trim() !== frontendRef) throw new Error('DEMO_FRONTEND_REF_MISMATCH');

await rm(TARGET_DIRECTORY, { recursive: true, force: true });
await cp(SOURCE_DIRECTORY, TARGET_DIRECTORY, {
  recursive: true,
  filter: (source) => source !== path.join(SOURCE_DIRECTORY, '.git'),
});
await assertFrontendContract(TARGET_DIRECTORY);
await writeDeploymentMetadata(TARGET_DIRECTORY, process.env, frontendRef);
await fingerprintDemoAssets(TARGET_DIRECTORY);
process.stdout.write(`Prepared immutable Demo frontend ${frontendRef} from reviewed submodule.\n`);
