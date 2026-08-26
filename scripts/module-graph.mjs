import path from 'node:path';

const STATIC_MODULE_PATTERN = /(?:import\s+(?:(?:[\w$]+(?:\s*,\s*(?:\*\s+as\s+[\w$]+|\{[\s\S]*?\}))?|\*\s+as\s+[\w$]+|\{[\s\S]*?\})\s+from\s+)?|export\s+(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[\s\S]*?\})\s+from\s+)['"]([^'"]+)['"]/g;
const DYNAMIC_MODULE_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function normalized(file) {
  return path.posix.normalize(String(file).replaceAll('\\', '/'));
}

export function moduleSpecifiers(source) {
  const text = String(source || '');
  const specifiers = [];
  for (const match of text.matchAll(STATIC_MODULE_PATTERN)) specifiers.push(match[1].split('?')[0]);
  for (const match of text.matchAll(DYNAMIC_MODULE_PATTERN)) specifiers.push(match[1].split('?')[0]);
  return Object.freeze(specifiers);
}

export function resolveRelativeModule(fromFile, specifier, knownFiles) {
  if (!String(specifier).startsWith('.')) return null;
  const files = knownFiles instanceof Set ? knownFiles : new Set(knownFiles);
  const base = normalized(path.posix.join(path.posix.dirname(normalized(fromFile)), specifier));
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
      if (!specifier.startsWith('.')) continue;
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
  const canonical = rotations.map((rotation) => rotation.join(' -> ')).sort()[0];
  return canonical;
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
