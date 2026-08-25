import { readFile } from 'node:fs/promises';

async function text(path) {
  return readFile(path, 'utf8');
}

function requireContains(content, values, label) {
  for (const value of values) {
    if (!content.includes(value)) {
      throw new Error(`${label} is missing required security baseline marker: ${value}`);
    }
  }
}

const packageJson = JSON.parse(await text('package.json'));
const security = await text('src/security.js');
const config = await text('src/config.js');
const cookie = await text('src/identity/session-cookie.js');
const entraClient = await text('src/identity/entra-client.js');
const entraAuth = await text('src/identity/entra-auth-service.js');
const microsoft365Client = await text('src/integrations/microsoft365-client.js');
const microsoft365Routes = await text('src/http/microsoft365-routes.js');
const microsoft365Repository = await text(
  'src/persistence/postgres/microsoft365-connection-repository.js',
);
const ci = await text('.github/workflows/ci.yml');
const dependencyPolicy = await text('.github/workflows/dependency-review.yml');
const secretScan = await text('.github/workflows/secret-scan.yml');
const threatModel = await text('docs/THREAT-MODEL.md');
const secureConfig = await text('docs/PRODUCTION-SECURE-CONFIGURATION.md');
const entraContract = await text('docs/ENTRA-AUTHENTICATION.md');
const microsoft365Contract = await text('docs/MICROSOFT365-CONNECTION.md');
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
  'ENTRA_CLIENT_ID_REQUIRED',
  'ENTRA_CLIENT_SECRET_REQUIRED',
  'OIDC_TRANSACTION_SECRET_REQUIRED',
  'MICROSOFT365_CONSENT_TTL_SECONDS',
  'MICROSOFT365_GRAPH_TIMEOUT_MS',
  "microsoftIdentity: 'https://login.microsoftonline.com'",
  "microsoftGraph: 'https://graph.microsoft.com'",
  'SERVICE_VERSION_REQUIRED',
  'BUILD_ID_REQUIRED',
], 'Production configuration');

requireContains(cookie, [
  'Path=/api',
  'HttpOnly',
  'SameSite=Lax',
  "['Secure']",
], 'Session cookie');

if (cookie.includes('Domain=')) {
  throw new Error('Session cookie must not use a broad Domain attribute.');
}

requireContains(entraClient, [
  'ConfidentialClientApplication',
  "codeChallengeMethod: 'S256'",
  'claims.aud !== clientId',
  'claims.iss !== expectedIssuer',
  'secureHashMatch(claims.nonce',
], 'Microsoft Entra adapter');
requireContains(entraAuth, [
  "createHash('sha256')",
  "createHmac('sha256'",
  'repository.consume',
  'identityResolver.resolve',
  'sessionService.issue',
], 'Microsoft Entra authentication orchestration');
requireContains(entraContract, [
  'organizational directory',
  'PKCE',
  'state',
  'nonce',
  'Tenant claiming',
  'Live authentication',
], 'Microsoft Entra security contract');

requireContains(microsoft365Client, [
  'APPROVED_OUTBOUND_ORIGINS.microsoftIdentity',
  'APPROVED_OUTBOUND_ORIGINS.microsoftGraph',
  "const GRAPH_SCOPE = `${GRAPH_ORIGIN}/.default`",
  "redirect: 'error'",
  'AbortSignal.timeout(timeoutMs)',
  'GRAPH_RESPONSE_MAX_BYTES',
  'response.body?.getReader?.()',
  'await cancelReader(reader)',
  "'Place.Read.All'",
  "'Calendars.ReadBasic.All'",
], 'Microsoft 365 provider client');
if (microsoft365Client.includes('await response.text()')) {
  throw new Error('Microsoft Graph responses must be bounded while streaming, not after response.text().');
}
requireContains(microsoft365Routes, [
  "callback: '/api/v1/integrations/microsoft365/callback'",
  'CALLBACK_QUERY_KEYS',
  'CALLBACK_VALUE_LIMITS',
  'CONTROL_CHARACTER',
  'searchParams.getAll(key)',
  'principalGuard.require(request, { csrf: mutation })',
  'assertEmptyBody(request)',
  "sendRedirect(response, '/?integration=microsoft365_connection_failed')",
], 'Microsoft 365 HTTP boundary');
requireContains(microsoft365Repository, [
  'pg_advisory_xact_lock',
  'connection_version = connection_version + 1',
  'microsoft365-consent-delete-finalized',
  'AND connection_version = $3',
], 'Microsoft 365 persistence concurrency boundary');
requireContains(microsoft365Contract, [
  'one-time server-side consent transaction',
  'browser-selected internal Tenant ID',
  'Place.Read.All',
  'Calendars.ReadBasic.All',
  'Exchange Online Application RBAC',
  'Migration `011_microsoft365_connection_lifecycle`',
], 'Microsoft 365 security contract');

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
  'Consent callback forgery/replay',
  'Mandatory release security gates',
], 'Threat model');
requireContains(secureConfig, [
  'Dynamic security testing',
  'SAST, SCA, dependency and secret controls',
  'Fail-closed deployment blockers',
  'DATABASE_SSL',
  'CSRF_SECRET',
  'AUDIT_HMAC_SECRET',
  'MICROSOFT365_CONSENT_TTL_SECONDS',
  'MICROSOFT365_GRAPH_TIMEOUT_MS',
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
