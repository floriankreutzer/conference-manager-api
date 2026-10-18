import { exactProductObject, requireProductCondition } from '../src/observability/product-delivery-contract.js';
import { normalizeRenderMetric } from './support/render-metric-normalizer.mjs';
import {
  normalizeHostedFrontendBinding, normalizeRenderDelivery, normalizeWebsiteDeployment,
} from './support/delivery-source-normalizer.mjs';

const normalizers = Object.freeze({
  render_metric: normalizeRenderMetric,
  hosted_frontend_binding: normalizeHostedFrontendBinding,
  render_delivery: normalizeRenderDelivery,
  website_delivery: normalizeWebsiteDeployment,
});

// Fixed offline entrypoint for the existing authorized connector task. No provider transport.
try {
  requireProductCondition(process.argv.length === 2);
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    requireProductCondition(length <= 2_000_000);
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  exactProductObject(input, ['kind', 'source']);
  requireProductCondition(Object.hasOwn(normalizers, input.kind));
  const result = normalizers[input.kind](input.source);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write('PROVIDER_OBSERVATION_NORMALIZATION_FAILED\n');
  process.exitCode = 1;
}
