import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('actual browser CI Python matches APT tab metadata and changes only trusted mirror priorities', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const match = workflow.match(/sudo python3 - <<'PY'\n([\s\S]*?)\n          PY/);
  assert.ok(match, 'The existing bounded mirror preference step is required');
  const source = match[1].split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
  const directory = await mkdtemp(path.join(tmpdir(), 'cm-browser-mirror-'));
  const file = path.join(directory, 'apt-mirrors.txt');
  const azure = 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1';
  const archive = 'https://archive.ubuntu.com/ubuntu/\tpriority:2';
  const original = `# trusted runner mirrors\n${azure}\n${archive}\nhttps://security.ubuntu.com/ubuntu/\ttype:index\n`;
  const execute = () => {
    const isolated = source.replace("'/etc/apt/apt-mirrors.txt'", JSON.stringify(file));
    assert.notEqual(isolated, source, 'The test must never touch the actual system mirror list');
    const result = spawnSync('python3', ['-c', isolated], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    await writeFile(file, original);
    assert.match(execute(), /official Ubuntu HTTPS mirror first/);
    const expected = original.replace(azure, azure.slice(0, -1) + '2')
      .replace(archive, archive.slice(0, -1) + '1');
    assert.equal(await readFile(file, 'utf8'), expected);
    // Already preferred, missing, duplicated and unfamiliar formats never broaden APT authority.
    for (const unchanged of [expected, `${original}${azure}\n`, original.replace(archive, 'https://unknown.invalid/'),
      original.replaceAll('\t', '\\t')]) {
      await writeFile(file, unchanged);
      assert.match(execute(), /retaining its trusted defaults/);
      assert.equal(await readFile(file, 'utf8'), unchanged);
    }
    await rm(file);
    execute();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
