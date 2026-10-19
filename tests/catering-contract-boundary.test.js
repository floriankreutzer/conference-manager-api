import assert from 'node:assert/strict';
import test from 'node:test';
import { backendSaas2BoundaryViolations } from '../scripts/backend-boundary-policy.mjs';

const CONTRACT = 'src/integrations/catering-contract.js';

test('catering application may consume neutral contracts without importing provider adapters', () => {
  assert.deepEqual(backendSaas2BoundaryViolations({
    [CONTRACT]: "import '../domain/identifiers.js'; import '../domain/catering-order-limits.js'; import './provider-registry.js';",
    'src/domain/catering-order-limits.js': 'export const CATERING_MAX_ORDER_POSITIONS = 101;',
    'src/domain/identifiers.js': 'export const isInternalUuid = () => true;',
    'src/integrations/provider-registry.js': 'export const registry = true;',
    'src/application/catering-service.js': "import '../integrations/catering-contract.js';",
  }), []);
});

test('catering response validation cannot acquire SDK, transport, persistence or runtime authority', () => {
  for (const source of [
    "import sdk from '@azure/msal-node';", "import './microsoft365-client.js';",
    "import '../domain/catering-order-snapshot.js';",
    "import('../domain/identifiers.js');", "fetch('https://untrusted.invalid');", 'const environment = process.env;',
    "global.fetch('https://untrusted.invalid');", "new WebSocket('wss://untrusted.invalid');", 'const transport = fetch;',
  ]) {
    assert.ok(backendSaas2BoundaryViolations({ [CONTRACT]: source })
      .some((v) => v.includes('neutral registration and internal identifiers')));
  }
});

test('shared order limits remain import-free and cannot acquire runtime authority', () => {
  const file = 'src/domain/catering-order-limits.js';
  for (const source of ["import './request.js';", 'const value = process.env;', "fetch('https://untrusted.invalid');"]) {
    assert.ok(backendSaas2BoundaryViolations({ [file]: source }).some((value) => value.includes('import-free, network-free')));
  }
});

test('catering configuration has only neutral descriptor and business-policy dependencies', () => {
  const file = 'src/integrations/catering-configuration.js';
  assert.deepEqual(backendSaas2BoundaryViolations({
    [file]: "import '../domain/catering-approval-policy.js'; import './provider-registry.js';",
    'src/domain/catering-approval-policy.js': 'export const mode = true;',
    'src/integrations/provider-registry.js': 'export const registry = true;',
    'src/application/reference-service.js': "import '../integrations/catering-configuration.js';",
  }), []);
  for (const source of ["import './microsoft365-client.js';", 'const environment = process.env;', 'const send = fetch;']) {
    assert.ok(backendSaas2BoundaryViolations({ [file]: source }).some((value) => value.includes('provider-neutral value contract')));
  }
});

test('manual and API receipts share one pure domain value contract behind the unchanged provider export', () => {
  assert.deepEqual(backendSaas2BoundaryViolations({
    [CONTRACT]: "export { normalizeCateringReceipt } from '../domain/catering-receipt.js'; import './provider-registry.js';",
    'src/domain/catering-receipt.js': "import './identifiers.js'; import './catering-order-limits.js';",
    'src/domain/catering-manual-contract.js': "import './identifiers.js'; import './catering-receipt.js';",
    'src/domain/identifiers.js': 'export const id = true;',
    'src/domain/catering-order-limits.js': 'export const maximum = 101;',
    'src/integrations/provider-registry.js': 'export const registry = true;',
    'src/persistence/postgres/manual-repository.js': "import '../../domain/catering-manual-contract.js';",
    'src/application/manual-service.js': "import '../domain/catering-manual-contract.js';",
  }), []);
  for (const file of ['src/domain/catering-receipt.js','src/domain/catering-receipt-state.js','src/domain/catering-manual-contract.js',
    'src/domain/catering-version-proposal.js','src/domain/catering-order-withdrawal.js',
    'src/domain/catering-provider-catalogue.js','src/domain/catering-catalogue-publication.js',
    'src/domain/catering-operational-health.js']) {
    for (const source of ["import sdk from '@azure/msal-node';", "import '../application/service.js';",
      "import '../integrations/catering-contract.js';", "import('./identifiers.js');", "fetch('https://untrusted.invalid');",
      'const config = process.env;', 'const scope = globalThis;']) {
      assert.ok(backendSaas2BoundaryViolations({ [file]: source }).some((value) => value.includes('pure, bounded domain contracts')));
    }
  }
});
