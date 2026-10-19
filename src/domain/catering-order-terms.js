import { normalizeCateringProviderTerms } from './catering-provider-catalogue.js';
import { normalizeCateringOrderTotal } from './catering-order-money.js';

const OPERATIONS=new Set(['initial','change','cancel']);
function invalid() { throw new TypeError('CATERING_ORDER_TERMS_INPUT_INVALID'); }
function record(value,keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own=Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(name=>{
    const property=Object.getOwnPropertyDescriptor(value,name);
    return !keys.includes(name) || !property.enumerable || !Object.hasOwn(property,'value');
  })) invalid();
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) invalid();
  const number=Date.parse(value); const canonical=value.includes('.') ? value : value.slice(0,-1)+'.000Z';
  if (!Number.isSafeInteger(number) || new Date(number).toISOString() !== canonical) invalid(); return number;
}
function deadline(start,minutes) { return minutes === null ? null : new Date(start-minutes*60000).toISOString(); }

// Necessary timing/minimum conditions from independently loaded supplier terms
// and a known full supplier quote. It grants no actor, cost-approval, availability,
// reservation or delivery authority and never substitutes a selling-price total.
export function evaluateCateringOrderTerms(value,expected) {
  const terms=normalizeCateringProviderTerms(value);
  record(expected,['operation','now','startsAt','originalStartsAt','supplierCost']);
  if (!OPERATIONS.has(expected.operation)) invalid(); const now=instant(expected.now);
  const cancel=expected.operation === 'cancel'; const initial=expected.operation === 'initial';
  if ((cancel && expected.startsAt !== null) || (initial && expected.originalStartsAt !== null)) invalid();
  const start=cancel ? null : instant(expected.startsAt);
  const original=initial ? null : instant(expected.originalStartsAt);
  const cost=expected.supplierCost === null ? null : normalizeCateringOrderTotal(expected.supplierCost);
  const leadAt=cancel ? null : deadline(start,terms.minimumLeadTimeMinutes);
  const changeAt=expected.operation === 'change' ? deadline(original,terms.changeCutoffMinutes) : null;
  const cancelAt=cancel ? deadline(original,terms.cancelCutoffMinutes) : null;
  const reasons=[];
  if (!cancel) {
    if (leadAt === null) reasons.push('lead_time_unknown');
    else if (now>Date.parse(leadAt)) reasons.push('lead_time_elapsed');
    if (terms.minimumOrderValue === null) reasons.push('minimum_value_unknown');
    else if (cost === null) reasons.push('supplier_cost_unknown');
    else if (cost.currency !== terms.minimumOrderValue.currency) reasons.push('supplier_currency_mismatch');
    else if (cost.amountMinor<terms.minimumOrderValue.amountMinor) reasons.push('minimum_value_not_met');
  }
  if (expected.operation === 'change') {
    if (changeAt === null) reasons.push('change_deadline_unknown');
    else if (now>Date.parse(changeAt)) reasons.push('change_deadline_elapsed');
  }
  if (cancel) {
    if (cancelAt === null) reasons.push('cancel_deadline_unknown');
    else if (now>Date.parse(cancelAt)) reasons.push('cancel_deadline_elapsed');
  }
  return Object.freeze({allowed:reasons.length === 0,reasons:Object.freeze(reasons),minimumApplies:!cancel,
    minimumOrderValue:terms.minimumOrderValue,deadlines:Object.freeze({leadAt,changeAt,cancelAt})});
}
