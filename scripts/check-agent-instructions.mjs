import { readFile } from 'node:fs/promises';

const genericPointer = [
  '# Agent Instructions',
  '',
  'Read and follow `AGENTS.md` before any analysis, review, code change, refactoring, or validation in this repository.',
  '',
].join('\n');

const copilotPointer = [
  '# GitHub Copilot Instructions',
  '',
  'Read and follow the repository root `AGENTS.md` before proposing, reviewing, generating, or modifying code.',
  '`AGENTS.md` is the canonical instruction source.',
  '',
].join('\n');

const expected = new Map([
  ['CLAUDE.md', genericPointer],
  ['GEMINI.md', genericPointer],
  ['.github/copilot-instructions.md', copilotPointer],
]);

const agents = await readFile('AGENTS.md', 'utf8');
const standards = await readFile('docs/CODING-STANDARDS.md', 'utf8');

const requiredAgentMarkers = [
  'docs/CODING-STANDARDS.md',
  'Tenant isolation is mandatory',
  'Required compliance checklist',
  'Read `docs/CODING-STANDARDS.md` completely',
];

for (const marker of requiredAgentMarkers) {
  if (!agents.includes(marker)) {
    throw new Error(`AGENTS.md is missing required backend governance marker: ${marker}`);
  }
}

for (let section = 1; section <= 23; section += 1) {
  if (!standards.includes(`## ${section}.`)) {
    throw new Error(`docs/CODING-STANDARDS.md is missing mandatory section ${section}.`);
  }
}

const requiredStandardMarkers = [
  'Node.js 22 with native ECMAScript modules',
  'BOLA / IDOR prevention is not optional',
  'Cookie-authenticated state-changing requests require server-generated and server-validated CSRF protection',
  'Use parameterized SQL for all application values',
  'SSRF (CWE-918)',
  'Regression tests protect existing behavior',
  'Progression tests prove newly introduced behavior',
  'Do not remove, weaken, skip, narrow, or rewrite valid tests merely to make an incorrect implementation pass',
  'OWASP/CWE-oriented secure development',
  'npm run test:db',
];

for (const marker of requiredStandardMarkers) {
  if (!standards.includes(marker)) {
    throw new Error(`docs/CODING-STANDARDS.md is missing required backend standard: ${marker}`);
  }
}

for (const [file, content] of expected) {
  const actual = await readFile(file, 'utf8');
  if (actual !== content) throw new Error(`${file} must only point to canonical AGENTS.md instructions.`);
}

console.log('Agent instruction and backend coding-standard consistency check passed.');
