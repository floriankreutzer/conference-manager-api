import { readFile, readdir } from 'node:fs/promises';
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
];
for (const file of files) {
  const content = await readFile(file, 'utf8');
  if (!content.endsWith('\n')) throw new Error(`${file} must end with a newline.`);
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    if (/\s+$/.test(line)) throw new Error(`${file}:${index + 1} contains trailing whitespace.`);
    if (line.includes('\t')) throw new Error(`${file}:${index + 1} contains a tab.`);
    if (line.length > 140) throw new Error(`${file}:${index + 1} exceeds 140 characters.`);
  });
}
console.log(`Style check passed for ${files.length} JavaScript files.`);
