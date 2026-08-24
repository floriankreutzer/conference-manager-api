import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(current));
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(current);
  }
  return files;
}

const files = [
  ...await filesUnder('src'),
  ...await filesUnder('tests'),
  ...await filesUnder('tests-db'),
  ...await filesUnder('scripts'),
].sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(1);
  }
}
console.log(`Syntax check passed for ${files.length} JavaScript files.`);
