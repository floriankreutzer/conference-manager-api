import { isInternalUuid } from './identifiers.js';

export class SyntheticOnboardingError extends Error {
  constructor(code) { super(code);this.name='SyntheticOnboardingError';this.code=code; }
}
const fail=()=>{ throw new SyntheticOnboardingError('SYNTHETIC_ONBOARDING_INPUT_INVALID'); };
export function normalizeSyntheticOnboardingCommand(value,operation) {
  const keys=operation==='import' ? ['expectedRevision','selectedKeys'] : ['expectedRevision','expectedStatus','targetStatus'];
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length!==keys.length
    || Reflect.ownKeys(value).some(key=>{
      const field=Object.getOwnPropertyDescriptor(value,key);return !keys.includes(key) || !Object.hasOwn(field,'value');
    }) || !['import','lifecycle'].includes(operation) || !Number.isSafeInteger(value.expectedRevision)
    || value.expectedRevision<1 || value.expectedRevision>=Number.MAX_SAFE_INTEGER) fail();
  if (operation==='import') {
    const selected=value.selectedKeys;
    if (!Array.isArray(selected) || Object.getPrototypeOf(selected)!==Array.prototype || selected.length<1 || selected.length>2
      || Reflect.ownKeys(selected).length!==selected.length+1) fail();
    const keys=Array.from({ length: selected.length },(_,index)=>{
      const field=Object.getOwnPropertyDescriptor(selected,String(index));
      if (!field || !Object.hasOwn(field,'value') || !['workshop','focus'].includes(field.value)) fail();return field.value;
    });
    if (new Set(keys).size!==keys.length) fail();
    return Object.freeze({ expectedRevision: value.expectedRevision,selectedKeys: Object.freeze(keys.sort()) });
  }
  if (!(value.expectedStatus==='onboarding' && value.targetStatus==='ready'
    || value.expectedStatus==='ready' && value.targetStatus==='active')) fail();
  return Object.freeze({ expectedRevision: value.expectedRevision,expectedStatus: value.expectedStatus,targetStatus: value.targetStatus });
}
export function syntheticOnboardingCandidates(runtime) {
  if (runtime?.mode!=='synthetic' || !isInternalUuid(runtime.tenantId) || !isInternalUuid(runtime.generationId)
    || !['northwind','contoso','fabrikam'].includes(runtime.slot)) fail();
  return runtime.slot!=='fabrikam' ? Object.freeze([]) : Object.freeze([
    Object.freeze({ key: 'workshop',name: 'Fabrikam Workshop',capacity: 12,building: 'Fabrikam Campus',timeZone: 'Europe/Berlin' }),
    Object.freeze({ key: 'focus',name: 'Fabrikam Focus',capacity: 6,building: 'Fabrikam Campus',timeZone: 'Europe/Berlin' }),
  ]);
}
