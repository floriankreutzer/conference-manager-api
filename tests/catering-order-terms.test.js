import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCateringOrderTerms as evaluate } from '../src/domain/catering-order-terms.js';
import { normalizeCateringProviderTerms } from '../src/domain/catering-provider-catalogue.js';
const money=(amountMinor,currency='EUR')=>({amountMinor,currency});
const terms=()=>({minimumLeadTimeMinutes:120,minimumOrderValue:money(1000),changeCutoffMinutes:60,cancelCutoffMinutes:30});
const expected=(overrides={})=>({operation:'initial',now:'2026-10-19T10:00:00.000Z',startsAt:'2026-10-19T12:00:00.000Z',
  originalStartsAt:null,supplierCost:money(1000),...overrides});
test('known lead time and exact full supplier minimum are inclusive at the exact boundary',()=>{
  const value=evaluate(terms(),expected()); assert.equal(value.allowed,true); assert.deepEqual(value.reasons,[]);
  assert.equal(value.deadlines.leadAt,'2026-10-19T10:00:00.000Z');
  assert.equal(value.deadlines.changeAt,null); assert.equal(value.minimumApplies,true);
  assert.deepEqual(evaluate(terms(),expected({now:'2026-10-19T10:00:00.001Z'})).reasons,['lead_time_elapsed']);
  assert.deepEqual(evaluate(terms(),expected({supplierCost:money(999)})).reasons,['minimum_value_not_met']);
});
test('unknown minimum/lead and absent supplier cost never become zero or a known-free quote',()=>{
  assert.deepEqual(evaluate({...terms(),minimumLeadTimeMinutes:null},expected()).reasons,['lead_time_unknown']);
  assert.deepEqual(evaluate({...terms(),minimumOrderValue:null},expected()).reasons,['minimum_value_unknown']);
  assert.deepEqual(evaluate({...terms(),minimumOrderValue:money(0)},expected({supplierCost:null})).reasons,['supplier_cost_unknown']);
  assert.equal(evaluate({...terms(),minimumOrderValue:money(0)},expected({supplierCost:money(0)})).allowed,true);
});
test('supplier minimum compares exact currency and safe aggregate cents rather than a unit or selling-price approximation',()=>{
  assert.deepEqual(evaluate(terms(),expected({supplierCost:money(1000,'USD')})).reasons,['supplier_currency_mismatch']);
  for (const currency of ['EUR','CHF','GBP','USD']) {
    const minimum=money(Number.MAX_SAFE_INTEGER-1,currency);
    assert.equal(evaluate({...terms(),minimumOrderValue:minimum},expected({supplierCost:minimum})).allowed,true);
    assert.deepEqual(evaluate({...terms(),minimumOrderValue:minimum},
      expected({supplierCost:money(minimum.amountMinor-1,currency)})).reasons,
      ['minimum_value_not_met']);
  }
});
test('change deadline stays anchored to the original conference and cannot be extended by a later proposed start',()=>{
  const originalStartsAt='2026-10-19T11:00:00.000Z';
  const change=expected({operation:'change',originalStartsAt,startsAt:'2026-10-20T12:00:00.000Z'});
  assert.equal(evaluate(terms(),change).allowed,true); assert.equal(evaluate(terms(),change).deadlines.changeAt,'2026-10-19T10:00:00.000Z');
  const value=evaluate(terms(),{...change,now:'2026-10-19T10:00:00.001Z'});
  assert.deepEqual(value.reasons,['change_deadline_elapsed']);
  assert.deepEqual(evaluate({...terms(),changeCutoffMinutes:null},change).reasons,['change_deadline_unknown']);
});
test('changes also satisfy the lead time and resulting supplier-order minimum independently of the original deadline',()=>{
  const change=expected({operation:'change',originalStartsAt:'2026-10-20T11:00:00.000Z',startsAt:'2026-10-19T11:00:00.000Z',
    supplierCost:money(999)});
  assert.deepEqual(evaluate(terms(),change).reasons,['lead_time_elapsed','minimum_value_not_met']);
});
test('cancellation uses its original deadline without inventing a new lead/minimum requirement',()=>{
  const cancel=expected({operation:'cancel',startsAt:null,originalStartsAt:'2026-10-19T10:30:00.000Z',supplierCost:null});
  const value=evaluate({...terms(),minimumLeadTimeMinutes:null,minimumOrderValue:null,changeCutoffMinutes:null},cancel);
  assert.equal(value.allowed,true); assert.equal(value.minimumApplies,false);
  assert.deepEqual(value.deadlines,{leadAt:null,changeAt:null,cancelAt:'2026-10-19T10:00:00.000Z'});
  assert.deepEqual(evaluate(terms(),{...cancel,now:'2026-10-19T10:00:00.001Z'}).reasons,['cancel_deadline_elapsed']);
  assert.deepEqual(evaluate({...terms(),cancelCutoffMinutes:null},cancel).reasons,['cancel_deadline_unknown']);
});
test('known zero deadlines retain exact semantics and expiry is not hidden by date-only or locale parsing',()=>{
  const zero={minimumLeadTimeMinutes:0,minimumOrderValue:money(0),changeCutoffMinutes:0,cancelCutoffMinutes:0};
  const now='2026-10-19T12:00:00.000Z'; assert.equal(evaluate(zero,expected({now,supplierCost:money(0)})).allowed,true);
  const cancel=expected({operation:'cancel',startsAt:null,originalStartsAt:now,now,supplierCost:null});
  assert.equal(evaluate(zero,cancel).allowed,true);
  assert.equal(evaluate(zero,{...cancel,now:'2026-10-19T12:00:00.001Z'}).allowed,false);
});
test('irrelevant unknown change/cancel terms do not block an initial order but never grant other operations',()=>{
  const partial={...terms(),changeCutoffMinutes:null,cancelCutoffMinutes:null}; assert.equal(evaluate(partial,expected()).allowed,true);
  assert.deepEqual(evaluate(partial,expected({operation:'change',originalStartsAt:'2026-10-20T12:00:00.000Z'})).reasons,
    ['change_deadline_unknown']);
});
test('closed operation/scope, canonical UTC instants and bounded nullable term values fail before authority can be inferred',()=>{
  for (const change of [{operation:'approved'},{tenantId:'foreign'},{sellingPrice:money(1000)},{now:'2026-10-19'},
    {now:'2026-10-19T10:00:00+00:00'},{now:'2026-02-30T10:00:00.000Z'},{supplierCost:{amountMinor:1.1,currency:'EUR'}},
    {supplierCost:{amountMinor:0,currency:'foreign'}},{originalStartsAt:'2026-10-19T12:00:00.000Z'},
    {operation:'cancel',startsAt:'2026-10-19T12:00:00.000Z'},{operation:'change',originalStartsAt:null}]) {
    assert.throws(()=>evaluate(terms(),expected(change)));
  }
  for (const change of [{minimumLeadTimeMinutes:-1},{changeCutoffMinutes:525601},{cancelCutoffMinutes:'0'},
    {minimumOrderValue:{amountMinor:-1,currency:'EUR'}},{approved:true}]) assert.throws(()=>evaluate({...terms(),...change},expected()));
  const value=expected(); let reads=0; Object.defineProperty(value,'now',{enumerable:true,get(){reads++;return expected().now;}});
  assert.throws(()=>evaluate(terms(),value)); assert.equal(reads,0);
});
test('term normalization and decisions are immutable and expose no supplied quote or cost-approval claim',()=>{
  const input=terms(); const context=expected(); const value=evaluate(input,context); input.minimumOrderValue.amountMinor=0;
  context.supplierCost.amountMinor=0; assert.equal(value.minimumOrderValue.amountMinor,1000);
  assert.equal(Object.isFrozen(value.reasons),true); assert.equal(Object.isFrozen(value.minimumOrderValue),true);
  assert.equal(Object.isFrozen(normalizeCateringProviderTerms(terms())),true);
  assert.doesNotMatch(JSON.stringify(value),/supplierCost|tenantId|approved|quoteRevision|available|orderId/);
});
