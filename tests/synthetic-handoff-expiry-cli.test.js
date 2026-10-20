import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Rejected configuration must fail before connecting, spawning a test or printing
// credentials. The reserved .invalid host is never permitted by this runner.
test('elapsed-proof runner refuses nonlocal, wrong environment, role, database and argument inputs without disclosure',()=>{
  const base={ ...process.env,NODE_ENV: 'test',DATABASE_SSL: 'disable',
    DATABASE_URL: 'postgresql://conference_manager:sentinel-private-password@localhost/conference_manager' };
  for (const [change,args] of [
    [{ DATABASE_URL: 'postgresql://conference_manager:sentinel-private-password@database.invalid/conference_manager' },[]],
    [{ NODE_ENV: 'production' },[]],[{ DATABASE_SSL: 'require' },[]],
    [{ DATABASE_URL: 'postgresql://foreign:sentinel-private-password@localhost/conference_manager' },[]],
    [{ DATABASE_URL: 'postgresql://conference_manager:sentinel-private-password@localhost/foreign' },[]],
    [{ DATABASE_URL: 'https://localhost/conference_manager' },[]],[{ DATABASE_URL: 'malformed-private-url' },[]],
    [{ DATABASE_URL: undefined },[]],[{},['--allow-remote']],
  ]) {
    const result=spawnSync(process.execPath,['scripts/test-synthetic-handoff-expiry.mjs',...args],
      { env: { ...base,...change },encoding: 'utf8',timeout: 10_000 });
    assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,1);
    assert.equal(result.stdout,'');assert.equal(result.stderr,'HANDOFF_EXPIRY_ACCEPTANCE_FAILED\n');
    assert.doesNotMatch(result.stderr,/sentinel|password|postgres|malformed|localhost|invalid/);
  }
});
