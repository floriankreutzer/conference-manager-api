import assert from 'node:assert/strict';
import test from 'node:test';
import { backendSaas2BoundaryViolations } from '../scripts/backend-boundary-policy.mjs';

const CONTRACT = 'src/integrations/provider-registry.js';

test('application code may depend on neutral registration without importing concrete adapters', () => {
  assert.deepEqual(backendSaas2BoundaryViolations({
    [CONTRACT]: 'export const createProviderRegistry = () => null;',
    'src/application/reference-service.js': "import { createProviderRegistry } from '../integrations/provider-registry.js';",
  }), []);
  const violations = backendSaas2BoundaryViolations({
    [CONTRACT]: 'export const createProviderRegistry = () => null;',
    'src/integrations/microsoft365-client.js': 'export const client = true;',
    'src/application/reference-service.js': "import '../integrations/microsoft365-client.js';",
  });
  assert.ok(violations.some((item) => item.includes('concrete provider module')));
});

test('registry cannot become a provider SDK, network, runtime or dynamic plugin boundary', () => {
  for (const source of [
    "import sdk from '@azure/msal-node';",
    "import('node:https');",
    "fetch('https://untrusted.invalid');",
    'const env = process.env;',
    'const transport = globalThis.fetch;',
  ]) {
    for (const file of [CONTRACT, 'src/integrations/delivery-policy.js']) {
      assert.ok(backendSaas2BoundaryViolations({ [file]: source }).some((item) => item.includes('metadata contract')));
    }
  }
});
