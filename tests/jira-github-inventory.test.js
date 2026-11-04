import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGithubPrInventory } from '../scripts/jira-github-inventory.mjs';

const token = 'test-only-credential';
const repos = ['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api'];
const pr = (repository, number = 1) => ({ number, title: 'CO-296 sample', draft: true, state: 'open',
  base: { repo: { full_name: repository } }, head: { sha: 'a'.repeat(40), ref: 'CO-296-sample' } });
const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('authenticated fixed-origin inventory covers both repositories and an empty terminal page', async () => {
  const calls = [];
  const result = await collectGithubPrInventory({ token, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    assert.equal(new URL(url).origin, 'https://api.github.com');
    const repository = repos.find((repo) => url.includes(`/repos/${repo}/pulls?`));
    assert.ok(repository);
    return response(url.endsWith('page=1') ? [pr(repository)] : []);
  } });
  assert.equal(calls.length, 4);
  assert.equal(result.inventories.length, 2);
  assert.equal(result.pullRequests[0].draft, true);
  assert.equal(result.pullRequests[0].merged, undefined);
  assert.equal(result.eligible, undefined);
  assert.equal(JSON.stringify(result).includes(token), false);
});

for (const status of [301, 401, 403, 429, 500]) {
  test(`rejects HTTP ${status} without leaking payload`, async () => {
    await assert.rejects(collectGithubPrInventory({ token, fetchImpl: async () =>
      new Response(token, { status }) }), { message: 'GITHUB_INVENTORY_UNVERIFIED' });
  });
}
for (const [name, mutate] of Object.entries({
  'unknown draft': (p) => { delete p.draft; },
  'foreign base': (p) => { p.base.repo.full_name = 'other/private'; },
  'bad SHA': (p) => { p.head.sha = 'main'; },
  'missing number': (p) => { delete p.number; },
})) {
  test(`rejects ${name}`, async () => {
    const value = pr(repos[0]);
    mutate(value);
    await assert.rejects(collectGithubPrInventory({ token, fetchImpl: async () => response([value]) }),
      { message: 'GITHUB_INVENTORY_UNVERIFIED' });
  });
}
test('rejects repeated page rather than returning a partial inventory', async () => {
  await assert.rejects(collectGithubPrInventory({ token, fetchImpl: async () => response([pr(repos[0])]) }),
    { message: 'GITHUB_INVENTORY_UNVERIFIED' });
});
test('missing credentials never call transport', async () => {
  await assert.rejects(collectGithubPrInventory({ fetchImpl: () => assert.fail('called') }),
    { message: 'GITHUB_INVENTORY_UNVERIFIED' });
});
test('transport exception is redacted', async () => {
  await assert.rejects(collectGithubPrInventory({ token, fetchImpl: () => { throw new Error(token); } }),
    { message: 'GITHUB_INVENTORY_UNVERIFIED' });
});
test('rejects oversized response', async () => {
  await assert.rejects(collectGithubPrInventory({ token, fetchImpl: async () => response('x'.repeat(4194304)) }),
    { message: 'GITHUB_INVENTORY_UNVERIFIED' });
});
