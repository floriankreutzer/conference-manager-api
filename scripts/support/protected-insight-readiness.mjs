import { loadProtectedPlatformInsightSnapshots } from '../../src/observability/platform-insight-snapshots.js';

// Operator-only inspection of the existing private aggregate configuration.
// No source values, identities, credentials, network access or runtime grants.
export function inspectProtectedInsightReadiness({ providerSnapshot,productSnapshot,now=Date.now() }={}) {
  const sources=loadProtectedPlatformInsightSnapshots({ providerSnapshot,productSnapshot });
  const product=sources.readProduct(now),provider=sources.readProvider(now);
  const missing=rows=>rows.filter(row=>row.value===null).map(({ id,reason })=>({ id,reason }));
  const productMissing=missing(product.product);
  const delivery=product.delivery.map(component=>({ component: component.component,
    missing: component.buckets.map((bucket,index)=>({ bucket: index+1,metrics: missing(bucket.metrics) })) }));
  const blockers=[];
  if (product.freshness!=='fresh') blockers.push('product_source_not_fresh');
  if (productMissing.some(row=>row.reason!=='empty_denominator')) blockers.push('product_source_incomplete');
  if (delivery.some(component=>component.missing.some(bucket=>bucket.metrics.some(row=>row.reason!=='empty_denominator')))) {
    blockers.push('delivery_source_incomplete');
  }
  if (product.feedback.source!=='protected_operator_registry' || product.feedback.total===null) blockers.push('feedback_source_incomplete');
  if (!provider || provider.freshness!=='fresh') blockers.push('provider_snapshot_not_fresh');
  // The currently owned provider contract supplies only the Neon reference
  // measurement. A current snapshot cannot certify other vendors or invoicing.
  blockers.push('render_source_not_connected','github_source_not_connected','resend_source_not_connected','metering_not_verified');
  return Object.freeze({ schemaVersion: 1,scope: 'protected_configured_sources',state: blockers.length ? 'incomplete' : 'ready',
    evaluatedAt: new Date(now).toISOString(),blockers,
    product: { collectionMode: product.collectionMode,freshness: product.freshness,
      availableMetrics: product.product.length-productMissing.length,totalMetrics: product.product.length,missing: productMissing },
    delivery,feedback: { configured: product.feedback.source==='protected_operator_registry',available: product.feedback.total!==null },
    providers: { configured: provider!==null,freshness: provider?.freshness ?? 'unknown',
      neonMeasurementAvailable: provider?.neon.usedBytes!==undefined,accountBillingVerified: false },
    metering: { state: 'not_verified',reason: 'authorized_tenant_period_read_required' } });
}
