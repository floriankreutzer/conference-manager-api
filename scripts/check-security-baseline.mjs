import { readFile } from 'node:fs/promises';

async function text(path) {
  return readFile(path, 'utf8');
}

function requireContains(content, values, label) {
  for (const value of values) {
    if (!content.includes(value)) throw new Error(`${label} is missing required security baseline marker: ${value}`);
  }
}

const packageJson = JSON.parse(await text('package.json'));
const security = await text('src/security.js');
const config = await text('src/config.js');
const cookie = await text('src/identity/session-cookie.js');
const ci = await text('.github/workflows/ci.yml');
const dependencyPolicy = await text('.github/workflows/dependency-review.yml');
const secretScan = await text('.github/workflows/secret-scan.yml');
const threatModel = await text('docs/THREAT-MODEL.md');
const secureConfig = await text('docs/PRODUCTION-SECURE-CONFIGURATION.md');
const pentest = await text('docs/PILOT-PENETRATION-TEST.md');

requireContains(security, [
  "Cache-Control', 'no-store",
  'Content-Security-Policy',
  'Strict-Transport-Security',
  'assertRequestHost',
  'assertSameOrigin',
  'assertSafeRequestTarget',
  'readJsonObjectBody',
], 'HTTP security implementation');

if (/Access-Control-Allow-Origin/i.test(security)) {
  throw new Error('Normal same-origin API security must not enable CORS in src/security.js.');
}

requireContains(config, [
  'PUBLIC_ORIGIN_HTTPS_REQUIRED',
  'DATABASE_URL_REQUIRED',
  'DATABASE_SSL_REQUIRED',
  'CSRF_SECRET_REQUIRED',
  'AUDIT_HMAC_SECRET_REQUIRED',
  'SERVICE_VERSION_REQUIRED',
  'BUILD_ID_REQUIRED',
], 'Production configuration');

requireContains(cookie, [
  'Path=/api',
  'HttpOnly',
  'SameSite=Lax',
  "['Secure']",
], 'Session cookie');

if (cookie.includes('Domain=')) throw new Error('Session cookie must not use a broad Domain attribute.');

requireContains(ci, [
  'npm ci --ignore-scripts --no-fund',
  'npm run audit',
  'npm run check',
], 'CI workflow');
requireContains(dependencyPolicy, [
  'npm ci --ignore-scripts --no-fund',
  'npm run audit',
  'npm run check:dependencies',
], 'Dependency Policy workflow');
requireContains(secretScan, [
  'fetch-depth: 0',
  'gitleaks/gitleaks-action@',
], 'Secret Scan workflow');

requireContains(threatModel, [
  'Microsoft Entra ID',
  'Microsoft Graph',
  'BOLA / IDOR',
  'CWE-352',
  'CWE-79',
  'CWE-89',
  'CWE-918',
  'Mandatory release security gates',
], 'Threat model');
requireContains(secureConfig, [
  'Dynamic security testing',
  'SAST, SCA, dependency and secret controls',
  'Fail-closed deployment blockers',
  'DATABASE_SSL',
  'CSRF_SECRET',
  'AUDIT_HMAC_SECRET',
], 'Production secure configuration');
requireContains(pentest, [
  'Tenant isolation / BOLA / IDOR',
  'Authentication and session abuse',
  'CSRF',
  'SSRF and outbound integration abuse',
  'Exit criteria',
], 'Pilot penetration-test scope');

const scripts = packageJson.scripts || {};
if (scripts['test:dast'] !== 'node scripts/security-dast.mjs') {
  throw new Error('package.json must expose the canonical live HTTP DAST gate as test:dast.');
}
if (scripts['check:security-baseline'] !== 'node scripts/check-security-baseline.mjs') {
  throw new Error('package.json must expose the canonical production security baseline gate.');
}
if (!scripts.check?.includes('npm run check:security-baseline') || !scripts.check?.includes('npm run test:dast')) {
  throw new Error('npm run check must execute both security-baseline and live HTTP DAST gates.');
}

console.log('Production security baseline gate passed.');
