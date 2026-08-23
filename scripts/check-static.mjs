import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const forbidden = [
  [/\beval\s*\(/, 'eval'],
  [/new\s+Function\s*\(/, 'new Function'],
  [/\bexecSync\s*\(/, 'execSync'],
  [/\bspawnSync\s*\(/, 'spawnSync'],
  [/\bexec\s*\(/, 'exec'],
  [/\bspawn\s*\(/, 'spawn'],
  [/\bfetch\s*\(\s*(?:request|req|body|input|url)/, 'user-controlled outbound fetch'],
  [/console\.(?:log|debug|info|warn|error)\s*\(/, 'direct console logging'],
];

async function scan(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(current);
    else if (entry.name.endsWith('.js')) {
      const content = await readFile(current, 'utf8');
      for (const [pattern, label] of forbidden) {
        if (pattern.test(content)) throw new Error(`${current} contains forbidden ${label} usage.`);
      }
    }
  }
}

await scan('src');
console.log('Defensive static security check passed.');
