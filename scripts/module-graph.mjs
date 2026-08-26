import path from 'node:path';
import { parse } from 'es-module-lexer/js';

function normalized(file) {
  return path.posix.normalize(String(file).replaceAll('\\', '/'));
}

function localModuleSpecifier(specifier) {
  const value = String(specifier);
  return value.startsWith('.') || value.startsWith('/');
}

export function moduleSpecifiers(source) {
  const text = String(source || '');
  const [imports] = parse(text);
  const specifiers = imports
    .filter((entry) => entry.d !== -2 && typeof entry.n === 'string')
    .map((entry) => entry.n.split(/[?#]/)[0]);
  return Object.freeze(specifiers);
}

export function resolveRelativeModule(fromFile, specifier, knownFiles) {
  if (!localModuleSpecifier(specifier)) return null;
  const files = knownFiles instanceof Set ? knownFiles : new Set(knownFiles);
  const base = String(specifier).startsWith('/')
    ? normalized(String(specifier).slice(1))
    : normalized(path.posix.join(path.posix.dirname(normalized(fromFile)), specifier));
  const candidates = path.posix.extname(base)
    ? [base]
    : [base, `${base}.js`, path.posix.join(base, 'index.js')];
  return candidates.find((candidate) => files.has(candidate)) || null;
}

export function buildModuleGraph(sourceEntries) {
  const sources = sourceEntries instanceof Map
    ? new Map([...sourceEntries].map(([file, source]) => [normalized(file), String(source)]))
    : new Map(Object.entries(sourceEntries || {}).map(([file, source]) => [normalized(file), String(source)]));
  const knownFiles = new Set(sources.keys());
  const graph = new Map();
  const unresolved = [];

  for (const [file, source] of sources) {
    const dependencies = new Set();
    for (const specifier of moduleSpecifiers(source)) {
      if (!localModuleSpecifier(specifier)) continue;
      const dependency = resolveRelativeModule(file, specifier, knownFiles);
      if (!dependency) unresolved.push(Object.freeze({ file, specifier }));
      else dependencies.add(dependency);
    }
    graph.set(file, Object.freeze([...dependencies].sort()));
  }

  return Object.freeze({ graph, unresolved: Object.freeze(unresolved) });
}

function canonicalCycle(cycle) {
  const pathWithoutRepeat = cycle.slice(0, -1);
  const rotations = pathWithoutRepeat.map((_, index) => [
    ...pathWithoutRepeat.slice(index),
    ...pathWithoutRepeat.slice(0, index),
  ]);
  return rotations.map((rotation) => rotation.join(' -> ')).sort()[0];
}

export function findModuleCycles(graph) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = new Map();

  function visit(file) {
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);

    for (const dependency of graph.get(file) || []) {
      if (!graph.has(dependency)) continue;
      if (visiting.has(dependency)) {
        const start = stack.indexOf(dependency);
        const cycle = [...stack.slice(start), dependency];
        cycles.set(canonicalCycle(cycle), Object.freeze(cycle));
      } else {
        visit(dependency);
      }
    }

    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }

  for (const file of [...graph.keys()].sort()) visit(file);
  return Object.freeze([...cycles.values()]);
}

export function isInside(file, root) {
  const candidate = normalized(file);
  const boundary = normalized(root).replace(/\/$/, '');
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
}
