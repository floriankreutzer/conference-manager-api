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
if (!agents.includes('Tenant isolation is mandatory') || !agents.includes('Required compliance checklist')) {
  throw new Error('AGENTS.md is missing required backend governance sections.');
}

for (const [file, content] of expected) {
  const actual = await readFile(file, 'utf8');
  if (actual !== content) throw new Error(`${file} must only point to canonical AGENTS.md instructions.`);
}
console.log('Agent instruction consistency check passed.');
