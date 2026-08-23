import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const highConfidencePatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
];
const excluded = new Set(['.git', 'node_modules']);

async function scan(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue;
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(current);
      continue;
    }
    if (/^\.env(?:\..+)?$/.test(entry.name) && entry.name !== '.env.example') {
      throw new Error(`Tracked environment file is prohibited: ${current}`);
    }
    if (!/\.(?:js|mjs|json|ya?ml|md|txt|example)$/.test(entry.name) && !entry.name.startsWith('.')) continue;
    const content = await readFile(current, 'utf8');
    for (const pattern of highConfidencePatterns) {
      if (pattern.test(content)) throw new Error(`Potential secret detected in ${current}.`);
    }
  }
}

await scan('.');
console.log('Repository secret pattern check passed.');
