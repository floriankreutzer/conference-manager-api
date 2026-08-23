import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(current));
    else if (entry.name.endsWith('.js')) files.push(current);
  }
  return files;
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (Object.keys(packageJson.dependencies || {}).length !== 0) {
  throw new Error('SaaS API foundation must remain runtime-dependency-free until a scoped issue introduces a reviewed dependency.');
}

const files = await sourceFiles('src');
for (const file of files) {
  const content = await readFile(file, 'utf8');
  if (file !== 'src/config.js' && /process\.env/.test(content)) {
    throw new Error(`${file} accesses process.env directly; runtime configuration belongs in src/config.js.`);
  }
  if (/from ['"](?:node:)?(?:fs|child_process|vm)['"]/.test(content)) {
    throw new Error(`${file} imports a privileged runtime module outside the approved foundation.`);
  }
  if (/https?:\/\//.test(content) && file !== 'src/config.js') {
    throw new Error(`${file} contains a hard-coded outbound URL; provider destinations require an approved integration boundary.`);
  }
}

const app = await readFile('src/app.js', 'utf8');
if (!app.includes("'/api/v1/health/live'") || !app.includes("'/api/v1/health/ready'") || !app.includes("'/api/v1/session'")) {
  throw new Error('Required foundation route contracts are missing.');
}
if (!app.includes('createPrincipalGuard') || !app.includes('assertSameOrigin') || !app.includes('createRateLimiter')) {
  throw new Error('Required API security boundaries are not composed in src/app.js.');
}
console.log('Architecture boundary check passed.');
