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
  for (const name of ['neon-browser-acceptance', 'neon-recovery-acceptance']) {
    const operational = await readFile(`.github/workflows/${name}.yml`, 'utf8');
    assert.equal(operational.match(/sudo python3 - <<'PY'\n([\s\S]*?)\n          PY/)?.[1], match[1],
      'All browser prerequisite steps must preserve the same bounded mirror policy');
  }
  const source = match[1].split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
  const directory = await mkdtemp(path.join(tmpdir(), 'cm-browser-mirror-'));
  const file = path.join(directory, 'apt-mirrors.txt');
  const azure = 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1';
  const aws = 'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:1';
  const archive = 'https://archive.ubuntu.com/ubuntu/\tpriority:2';
  const execute = () => {
    const isolated = source.replace("'/etc/apt/apt-mirrors.txt'", JSON.stringify(file));
    assert.notEqual(isolated, source, 'The test must never touch the actual system mirror list');
    const result = spawnSync('python3', ['-c', isolated], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    for (const cloud of [azure, aws]) {
      const original = `# trusted runner mirrors\n${cloud}\n${archive}\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n`;
      await writeFile(file, original);
      assert.match(execute(), /official Ubuntu HTTPS mirror first/);
      const expected = original.replace(cloud, cloud.slice(0, -1) + '2')
        .replace(archive, archive.slice(0, -1) + '1');
      assert.equal(await readFile(file, 'utf8'), expected);
      const comments = `# ${cloud}\n# ${archive}\n`;
      await writeFile(file, comments + original);
      assert.match(execute(), /official Ubuntu HTTPS mirror first/);
      assert.equal(await readFile(file, 'utf8'), comments + expected);
      // Repeated, missing, ambiguous and unfamiliar entries retain their original bytes.
      for (const unchanged of [expected, `${original}${cloud}\n`, `${original}${archive}\n`,
        `${original}${cloud === azure ? aws : azure}\n`,
        original.replace(archive, 'https://unknown.invalid/'),
        original.replace(cloud, 'http://unknown.invalid/ubuntu/\tpriority:1'),
        original.replace(cloud, `# ${cloud}`), original.replaceAll('\t', '\\t'),
        original.replaceAll('\n', '\r\n')]) {
        await writeFile(file, unchanged);
        assert.match(execute(), /retaining its trusted defaults/);
        assert.equal(await readFile(file, 'utf8'), unchanged);
      }
    }
    await rm(file);
    execute();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
