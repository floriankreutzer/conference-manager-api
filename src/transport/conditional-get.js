const MAX_CONDITIONAL_HEADER = 8192;

export function matchesEntityTag(value, etag) {
  if (typeof value !== 'string' || value.length > MAX_CONDITIONAL_HEADER) return false;
  if (value.trim() === '*') return true;
  const candidates = value.split(',');
  if (candidates.length > 32) return false;
  if (candidates.some((candidate) => !/^(?:W\/)?"[a-zA-Z0-9_-]{1,128}"$/.test(candidate.trim()))) return false;
  return candidates.some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
}

export function selectStaticEncoding(value, { compressible }) {
  if (value === undefined || value === '') return 'identity';
  if (typeof value !== 'string' || value.length > 1024) return 'identity';
  const entries = value.split(',');
  if (entries.length > 8) return 'identity';
  const weights = new Map();
  for (const entry of entries) {
    const match = entry.trim().match(/^([a-zA-Z0-9*-]{1,32})(?:\s*;\s*q=(0(?:\.\d{1,3})?|1(?:\.0{1,3})?))?$/);
    if (!match || weights.has(match[1].toLowerCase())) return 'identity';
    weights.set(match[1].toLowerCase(), match[2] === undefined ? 1 : Number(match[2]));
  }
  const wildcard = weights.get('*');
  const identity = weights.get('identity') ?? (wildcard === 0 ? 0 : 1);
  const options = compressible ? ['br', 'gzip', 'identity'] : ['identity'];
  let selected = null;
  let highest = 0;
  for (const encoding of options) {
    const weight = encoding === 'identity' ? identity : weights.get(encoding) ?? wildcard ?? 0;
    if (weight > highest) { highest = weight; selected = encoding; }
  }
  return selected;
}
