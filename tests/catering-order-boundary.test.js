import assert from 'node:assert/strict';
import test from 'node:test';
import { backendSaas2BoundaryViolations } from '../scripts/backend-boundary-policy.mjs';

test('order and configuration composition cannot become a back door to concrete infrastructure', () => {
  for (const target of ['customer-composition','catering-configuration-composition','catering-order-composition']) {
    const dependency = `src/${target}.js`;
    for (const source of ['src/domain/checkout.js','src/application/order.js','src/http/order.js','src/persistence/postgres/order.js']) {
      const relative = source.startsWith('src/persistence') ? `../../${target}.js` : `../${target}.js`;
      assert.ok(backendSaas2BoundaryViolations({ [source]: `import '${relative}';`, [dependency]: 'export const root = true;' })
        .some((violation) => violation.includes('composition') || violation.includes('independent')));
    }
  }
  assert.deepEqual(backendSaas2BoundaryViolations({
    'src/customer-composition.js': "import './catering-order-composition.js';",
    'src/catering-order-composition.js': 'export const root = true;',
  }), []);
});
