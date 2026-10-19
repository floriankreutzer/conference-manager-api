import assert from 'node:assert/strict';
import test from 'node:test';
import { backendSaas2BoundaryViolations } from '../scripts/backend-boundary-policy.mjs';

const CONTRACT = 'src/integrations/catering-contract.js';

test('catering application may consume neutral contracts without importing provider adapters', () => {
  assert.deepEqual(backendSaas2BoundaryViolations({
    [CONTRACT]: "import '../domain/identifiers.js'; import './provider-registry.js';",
    'src/domain/identifiers.js': 'export const isInternalUuid = () => true;',
    'src/integrations/provider-registry.js': 'export const registry = true;',
    'src/application/catering-service.js': "import '../integrations/catering-contract.js';",
  }), []);
});

test('catering response validation cannot acquire SDK, transport, persistence or runtime authority', () => {
  for (const source of [
    "import sdk from '@azure/msal-node';", "import './microsoft365-client.js';",
    "import('../domain/identifiers.js');", "fetch('https://untrusted.invalid');", 'const environment = process.env;',
    "global.fetch('https://untrusted.invalid');", "new WebSocket('wss://untrusted.invalid');", 'const transport = fetch;',
  ]) {
    assert.ok(backendSaas2BoundaryViolations({ [CONTRACT]: source })
      .some((v) => v.includes('neutral registration and internal identifiers')));
  }
});
