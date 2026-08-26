import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { backendSaas2BoundaryViolations } from './backend-boundary-policy.mjs';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(current));
    else if (entry.name.endsWith('.js')) files.push(current.replaceAll('\\', '/'));
  }
  return files;
}

const sources = new Map();
for (const file of await sourceFiles('src')) sources.set(file, await readFile(file, 'utf8'));
const violations = backendSaas2BoundaryViolations(sources);
if (violations.length) {
  for (const item of violations) console.error(item);
  process.exit(1);
}
console.log(`General backend module boundary check passed for ${sources.size} source modules.`);
