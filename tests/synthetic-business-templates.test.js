import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createSyntheticBusinessTemplates,SYNTHETIC_BUSINESS_TEMPLATE_DIGEST,SYNTHETIC_BUSINESS_TEMPLATE_VERSION,
} from '../src/synthetic/business-templates.js';
import { DEMO_FIXTURE,DEMO_FIXTURE_CHECKSUM } from '../src/demo/fixture.js';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

test('shared pure business templates preserve complete canonical Demo facts and its unchanged semantic checksum',()=>{
  const templates=createSyntheticBusinessTemplates();
  assert.deepEqual(templates,DEMO_FIXTURE.tenants.map(({ providerSimulation,...business })=>business));
  assert.equal(DEMO_FIXTURE_CHECKSUM,'7e22005f1e9689fbea4ccfc75084f5f3d224fe10e60a6af23c1cb600f2b70014');
  assert.equal(SYNTHETIC_BUSINESS_TEMPLATE_VERSION,'saas-3.7-three-customer-business-v1');
  assert.equal(createHash('sha256').update(JSON.stringify(templates)).digest('hex'),SYNTHETIC_BUSINESS_TEMPLATE_DIGEST);
  assert.equal(templates[0].settings.locations.flatMap(value=>value.rooms).length,10);assert.equal(templates[0].requests.length,20);
  assert.equal(templates[1].requests.length,3);assert.equal(templates[2].settings.locations.length,0);
});

test('each consumer owns its data copy; persona/provider/role authority never enters the reusable facts',()=>{
  const first=createSyntheticBusinessTemplates(),second=createSyntheticBusinessTemplates();
  first[0].displayName='Changed local clone';first[0].requests.length=0;
  assert.equal(second[0].displayName,'Northwind Demo');assert.equal(second[0].requests.length,20);
  assert.equal(DEMO_FIXTURE.tenants[0].requests.length,20);
  const forbidden=new Set(['providerSimulation','providerIdentity','customerPersonas','platform','roles','permissions']);
  function inspect(value) {
    if (!value || typeof value!=='object') return;
    for (const [key,item] of Object.entries(value)) { assert.equal(forbidden.has(key),false);inspect(item); }
  }
  inspect(second);
});

test('pure template graph rejects direct/transitive authority, SDK/network/timer imports and raw-data bypass',()=>{
  const root='src/synthetic/business-templates.js';
  for (const target of ['src/demo/fixture.js','src/identity/session-service.js','src/persistence/postgres/pool.js',
    'src/integrations/microsoft365-client.js','src/platform/identity/session-service.js']) {
    const graph={ [root]: `import '../${target.slice(4)}';`,[target]: 'export const authority=true;' };
    assert.ok(architectureConsolidationBoundaryViolations(graph).some(value=>value.includes('must remain pure fixed data')));
  }
  for (const source of ["import 'node:fs';","import '@azure/msal-node';",'const load=value=>import(value);',
    'fetch("https://127.0.0.1");','setTimeout(()=>{},1);']) {
    const graph={ [root]: "import '../domain/template-bridge.js';",'src/domain/template-bridge.js': source };
    assert.ok(architectureConsolidationBoundaryViolations(graph).some(value=>value.includes('must remain pure fixed data')));
  }
  assert.ok(architectureConsolidationBoundaryViolations({
    'src/customer-composition.js': "import './synthetic/business-template-data.js';",'src/synthetic/business-template-data.js': '',
  }).some(value=>value.includes('data is private')));
  assert.deepEqual(architectureConsolidationBoundaryViolations({ [root]:
    "import { createHash } from 'node:crypto'; import './business-template-data.js';",'src/synthetic/business-template-data.js': '' }),[]);
});
