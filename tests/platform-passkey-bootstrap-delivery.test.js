import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { constants, createHash, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectPrivateBootstrapGrant, requirePlatformPasskeyBootstrapDeliveryContext }
  from '../scripts/support/platform-passkey-bootstrap-delivery.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 4096 });
const fingerprint = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const uuid = suffix => `a1000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const grant = { grantId: uuid('9'), token: Buffer.alloc(32, 7).toString('base64url') };
function context() {
  return { GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'floriankreutzer', GITHUB_TRIGGERING_ACTOR: 'floriankreutzer',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'b'.repeat(40), EXPECTED_MAIN_SHA: 'b'.repeat(40),
    GITHUB_WORKFLOW_REF: 'floriankreutzer/conference-manager-api/.github/workflows/protected-int-passkey-bootstrap.yml@refs/heads/main',
    PLATFORM_OWNER_BOOTSTRAP_DIRECTORY_ID: uuid('3'), PLATFORM_OWNER_BOOTSTRAP_SUBJECT_ID: uuid('4'),
    PLATFORM_AUDIT_SEGMENT_ID: uuid('2'), PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH: uuid('1'),
    PLATFORM_SECURITY_EPOCH: '2', CM_INT_PASSKEY_OPERATOR_ID: uuid('5'), CM_INT_PASSKEY_OPERATOR_VERSION: '1',
    CM_INT_PASSKEY_RECIPIENT_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    CM_INT_PASSKEY_RECIPIENT_SHA256: fingerprint,
    CM_INT_PASSKEY_REQUEST_JSON: JSON.stringify({ operatorId: uuid('5'), operatorSecurityVersion: 1,
      providerIdentity: { provider: 'microsoft_entra_platform', tenantReference: uuid('3'), subjectReference: uuid('4') },
      environment: 'int', securityEpoch: 2, kind: 'bootstrap', ttlSeconds: 900,
      approvalReference: 'SYNTHETIC-OWNER-APPROVAL', correlationId: uuid('6') }),
    CM_INT_PASSKEY_EVIDENCE: JSON.stringify({ sourceSha: 'b'.repeat(40), environment: 'int', deploymentEpoch: uuid('1'),
      segmentId: uuid('2'), operatorId: uuid('5'), identityReference: 'synthetic-identity-proof',
      custodyReference: 'synthetic-recipient-custody', servicesClosed: true }) };
}
function label() {
  return Buffer.from(JSON.stringify(['cm-int-passkey-bootstrap:v1', 'b'.repeat(40), uuid('6'), uuid('5'), 1,
    'int', 2, uuid('2'), uuid('1'), fingerprint]));
}

test('bootstrap delivery uses actual RSA-OAEP/SHA256 and exact source/operator/deployment recipient binding', () => {
  const actual = requirePlatformPasskeyBootstrapDeliveryContext(context());
  const encrypted = actual.encrypt(grant);
  const envelope = JSON.parse(encrypted);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'format']);
  assert.equal(envelope.format, 'cm-int-passkey-bootstrap:v1');
  assert.equal(Buffer.from(envelope.ciphertext, 'base64url').length, 512);
  assert.equal(encrypted.includes(grant.token), false);
  assert.equal(encrypted.includes(grant.grantId), false);
  const parameters = { key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256', oaepLabel: label() };
  assert.deepEqual(JSON.parse(privateDecrypt(parameters, Buffer.from(envelope.ciphertext, 'base64url'))), grant);
  assert.throws(() => privateDecrypt({ ...parameters, oaepLabel: Buffer.from('other-source-or-recipient') },
    Buffer.from(envelope.ciphertext, 'base64url')));
  const corrupted = Buffer.from(envelope.ciphertext, 'base64url'); corrupted[20] ^= 1;
  assert.throws(() => privateDecrypt(parameters, corrupted));
  for (const value of [{ ...grant, token: 'invalid' }, { ...grant, extra: 'private-canary' }, { grantId: uuid('9') }]) {
    assert.throws(() => actual.encrypt(value));
  }
});

test('bootstrap transport refuses non-owner contexts, stale authority, recovery and unverified recipients before issuance', () => {
  for (const patch of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_ACTOR: 'other' }, { GITHUB_TRIGGERING_ACTOR: 'other' },
    { GITHUB_REF: 'refs/tags/release' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_WORKFLOW_REF: 'other' },
    { GITHUB_REPOSITORY: 'other/repository' }, { EXPECTED_MAIN_SHA: 'c'.repeat(40) }, { RUNNER_DEBUG: '1' },
    { ACTIONS_STEP_DEBUG: 'true' }, { ACTIONS_RUNNER_DEBUG: 'true' }, { NODE_OPTIONS: 'private-canary' },
    { PLATFORM_OWNER_BOOTSTRAP_DIRECTORY_ID: uuid('4') }, { PLATFORM_OWNER_BOOTSTRAP_SUBJECT_ID: uuid('3') },
    { CM_INT_PASSKEY_OPERATOR_ID: uuid('6') }, { CM_INT_PASSKEY_OPERATOR_VERSION: '2' },
    { PLATFORM_SECURITY_EPOCH: '3' }, { PLATFORM_AUDIT_SEGMENT_ID: uuid('1') },
    { PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH: uuid('2') }, { CM_INT_PASSKEY_RECIPIENT_SHA256: '0'.repeat(64) },
    { CM_INT_PASSKEY_RECIPIENT_PUBLIC_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    { CM_INT_PASSKEY_REQUEST_JSON: 'x'.repeat(4097) }, { CM_INT_PASSKEY_EVIDENCE: '{}' }]) {
    assert.throws(() => requirePlatformPasskeyBootstrapDeliveryContext({ ...context(), ...patch }),
      { message: 'PLATFORM_PASSKEY_BOOTSTRAP_DELIVERY_REFUSED' });
  }
  for (const patch of [{ kind: 'recovery' }, { kind: 'additional' }, { environment: 'prod' }, { ttlSeconds: 901 },
    { ttlSeconds: 60 }, { securityEpoch: 3 }, { operatorSecurityVersion: 2 }, { roles: ['platform_security_admin'] },
    { issuedFromSessionId: null }]) {
    const env = context(); env.CM_INT_PASSKEY_REQUEST_JSON = JSON.stringify({ ...JSON.parse(env.CM_INT_PASSKEY_REQUEST_JSON), ...patch });
    assert.throws(() => requirePlatformPasskeyBootstrapDeliveryContext(env));
  }
  for (const patch of [{ sourceSha: 'c'.repeat(40) }, { servicesClosed: false }, { environment: 'dev' },
    { operatorId: uuid('6') }, { identityReference: '' }, { custodyReference: 'private\ncanary' }, { extra: true }]) {
    const env = context(); env.CM_INT_PASSKEY_EVIDENCE = JSON.stringify({ ...JSON.parse(env.CM_INT_PASSKEY_EVIDENCE), ...patch });
    assert.throws(() => requirePlatformPasskeyBootstrapDeliveryContext(env));
  }
  const weak = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  const env = { ...context(), CM_INT_PASSKEY_RECIPIENT_PUBLIC_KEY: weak.export({ type: 'spki', format: 'pem' }),
    CM_INT_PASSKEY_RECIPIENT_SHA256: createHash('sha256').update(weak.export({ type: 'spki', format: 'der' })).digest('hex') };
  assert.throws(() => requirePlatformPasskeyBootstrapDeliveryContext(env));
});

function privateChild(output, code = 0) {
  const source = `import {readFileSync,writeSync} from 'node:fs';
    const request=JSON.parse(readFileSync(3,'utf8'));
    if(request.kind!=='bootstrap')process.exit(9);
    writeSync(1,'PRIVATE_STDOUT_CANARY');writeSync(2,'PRIVATE_STDERR_CANARY');
    writeSync(4,${JSON.stringify(output)});process.exit(${code});`;
  return spawn(process.execPath, ['--input-type=module', '-e', source],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], timeout: 5000 });
}

test('actual FD3/FD4 pipes transfer only a bounded canonical grant and refuse failed or malformed delivery', async () => {
  assert.deepEqual(await collectPrivateBootstrapGrant(privateChild(JSON.stringify(grant)), { kind: 'bootstrap' }), grant);
  for (const output of ['', 'invalid-json', 'x'.repeat(1025), JSON.stringify({ ...grant, extra: true })]) {
    await assert.rejects(collectPrivateBootstrapGrant(privateChild(output), { kind: 'bootstrap' }),
      { message: 'PLATFORM_PASSKEY_BOOTSTRAP_DELIVERY_REFUSED' });
  }
  await assert.rejects(collectPrivateBootstrapGrant(privateChild(JSON.stringify(grant), 1), { kind: 'bootstrap' }));
});

test('untrusted invocation refuses before output directory, network writer or secret-bearing output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'int-bootstrap-delivery-'));
  try {
    const child = spawnSync(process.execPath, ['scripts/platform-passkey-bootstrap-deliver.mjs'],
      { env: { RUNNER_TEMP: directory }, encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, ''); assert.equal(child.stderr, 'PLATFORM_PASSKEY_BOOTSTRAP_DELIVERY_REFUSED\n');
    assert.equal(existsSync(join(directory, 'protected-int-passkey-grant')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workflow retains only ciphertext after locked install; never exposes requests or invokes other administrative operations', () => {
  const workflow = readFileSync('.github/workflows/protected-int-passkey-bootstrap.yml', 'utf8');
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /group: hosted-shared-demo-database-initialize/);
  assert.match(workflow, /github\.run_attempt == 1/);
  assert.match(workflow, /retention-days: 1/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/protected-int-passkey-grant\/grant\.json/);
  assert.match(workflow, /PLATFORM_PASSKEY_OFFLINE_DATABASE_URL: \$\{\{ secrets\.CM_INT_AUDIT_OFFLINE_DATABASE_URL \}\}/);
  assert.ok(workflow.indexOf('Install locked dependencies') < workflow.indexOf('secrets.CM_INT_AUDIT_HMAC_SECRET'));
  assert.doesNotMatch(workflow, /pull_request_target:|GITHUB_ENV|GITHUB_OUTPUT|HOSTED_DEMO_.*DATABASE_URL|vars\.CM_INT_/);
  assert.doesNotMatch(workflow, /platform-owner-bootstrap\.mjs|db-migrate|demo-reset|start:protected/);
});


test('browser ciphertext discloses only public recipient references and a context hash; actual OAEP decryption remains bound',()=>{
  const env=context(),actual=requirePlatformPasskeyBootstrapDeliveryContext(env);
  const bundle=JSON.parse(actual.encryptForBrowser(grant));
  assert.deepEqual(Object.keys(bundle).sort(),['ciphertext','format','labelHash','recipientSha256','requestId']);
  assert.equal(bundle.format,'cm-int-passkey-browser-delivery:v1');assert.equal(bundle.requestId,uuid('6'));
  assert.equal(bundle.recipientSha256,fingerprint);assert.match(bundle.labelHash,/^[a-f0-9]{64}$/);
  for (const value of [grant.token,grant.grantId,uuid('5'),uuid('2'),uuid('1')]) {
    assert.equal(JSON.stringify(bundle).includes(value),false);
  }
  const parameters={ key: keys.privateKey,padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',oaepLabel: Buffer.from(bundle.labelHash,'hex') };
  assert.deepEqual(JSON.parse(privateDecrypt(parameters,Buffer.from(bundle.ciphertext,'base64url'))),grant);
  assert.throws(()=>privateDecrypt({ ...parameters,oaepLabel: label() },Buffer.from(bundle.ciphertext,'base64url')));
});

test('only the separate owner-main recovery workflow may request independently authorized canonical recovery',()=>{
  const env=context();env.GITHUB_WORKFLOW_REF=env.GITHUB_WORKFLOW_REF.replace('passkey-bootstrap.yml','passkey-recovery.yml');
  assert.throws(()=>requirePlatformPasskeyBootstrapDeliveryContext(env));
  env.CM_INT_PASSKEY_REQUEST_JSON=JSON.stringify({ ...JSON.parse(env.CM_INT_PASSKEY_REQUEST_JSON),kind: 'recovery' });
  const value=requirePlatformPasskeyBootstrapDeliveryContext(env);assert.equal(value.request.kind,'recovery');
  assert.equal(JSON.parse(value.encryptForBrowser(grant)).format,'cm-int-passkey-browser-delivery:v1');
  for (const patch of [{ GITHUB_ACTOR: 'other' },{ GITHUB_RUN_ATTEMPT: '2' },{ EXPECTED_MAIN_SHA: 'c'.repeat(40) },
    { GITHUB_REF: 'refs/heads/other' },{ GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('main','other') }]) {
    assert.throws(()=>requirePlatformPasskeyBootstrapDeliveryContext({ ...env,...patch }));
  }
  for (const kind of ['additional','bootstrap']) {
    assert.throws(()=>requirePlatformPasskeyBootstrapDeliveryContext({ ...env,
      CM_INT_PASSKEY_REQUEST_JSON: JSON.stringify({ ...JSON.parse(env.CM_INT_PASSKEY_REQUEST_JSON),kind }) }));
  }
  const workflow=readFileSync('.github/workflows/protected-int-passkey-recovery.yml','utf8');
  for (const required of ['github.run_attempt == 1','github.actor == \'floriankreutzer\'',
    'group: hosted-shared-demo-database-initialize','persist-credentials: false','retention-days: 1',
    'environment:','name: hosted-demo-initialize','node scripts/platform-passkey-bootstrap-deliver.mjs']) {
    assert.ok(workflow.includes(required));
  }
  assert.doesNotMatch(workflow,/pull_request_target:|GITHUB_OUTPUT|GITHUB_ENV|platform-owner-bootstrap|db-migrate|demo-reset/);
});
