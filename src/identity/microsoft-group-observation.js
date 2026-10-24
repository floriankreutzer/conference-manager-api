import { EntraAuthenticationError } from './entra-errors.js';

// Called only after the owned code-exchange adapter verified the organizational
// ID-token identity, nonce, audience and freshness. These are membership facts,
// never application roles. Overage endpoints are never followed.
export function microsoftGroupObservation(claims) {
  const invalid=()=>{ throw new EntraAuthenticationError('ENTRA_GROUP_CLAIM_INVALID'); };
  const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!claims || typeof claims!=='object' || Array.isArray(claims)) invalid();
  const overage=Object.hasOwn(claims,'hasgroups') || Object.hasOwn(claims._claim_names ?? {},'groups');
  if (overage) return Object.freeze({ status: 'overage',groupIds: Object.freeze([]) });
  if (!Object.hasOwn(claims,'groups')) return Object.freeze({ status: 'unavailable',groupIds: Object.freeze([]) });
  if (!Array.isArray(claims.groups) || claims.groups.length>200) invalid();
  const groups=[];
  for (const value of claims.groups) {
    if (typeof value!=='string' || !guid.test(value) || groups.includes(value.toLowerCase())) invalid();
    groups.push(value.toLowerCase());
  }
  return Object.freeze({ status: 'complete',groupIds: Object.freeze(groups.sort()) });
}
