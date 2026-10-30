import { inspectProtectedInsightReadiness } from './support/protected-insight-readiness.mjs';

try {
  if (process.argv.length!==2) throw new Error('ARGUMENTS_INVALID');
  const report=inspectProtectedInsightReadiness({
    providerSnapshot: process.env.PROTECTED_PLATFORM_PROVIDER_USAGE_SNAPSHOT,
    productSnapshot: process.env.PROTECTED_PLATFORM_PRODUCT_DELIVERY_SNAPSHOT,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.state!=='ready') process.exitCode=2;
} catch {
  process.stderr.write('PROTECTED_INSIGHT_READINESS_INVALID\n');process.exitCode=1;
}
