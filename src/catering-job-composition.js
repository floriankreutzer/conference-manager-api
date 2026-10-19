import { createCateringJobProcessor } from './application/catering-job-processor.js';
import { cateringDeliveryEnabled } from './feature-flags.js';
import { createCateringConfigurationRegistry } from './integrations/catering-provider-registration.js';
import { createIntegrationJobWorker } from './integrations/job-worker.js';
import { createHealthMonitor } from './observability/health.js';
import { createPostgresCateringJobRepository } from './persistence/postgres/catering-job-repository.js';

export function createCateringJobRuntime({ config, persistence, auditService, metrics, logger } = {}) {
  if (!cateringDeliveryEnabled(config?.featureFlags)) return null;
  if (config?.demoRuntime) throw new TypeError('CATERING_JOB_DEMO_NOT_SUPPORTED');
  if (!persistence?.pool || !Array.isArray(persistence.readinessChecks) || persistence.readinessChecks.length === 0) {
    throw new TypeError('CATERING_JOB_READINESS_REQUIRED');
  }
  if (typeof metrics?.recordIntegrationJobBatch !== 'function' || typeof metrics?.recordIntegrationJobBatchFailure !== 'function'
    || typeof logger?.lifecycle !== 'function') throw new TypeError('CATERING_JOB_TELEMETRY_REQUIRED');
  const registry = createCateringConfigurationRegistry();
  const repository = createPostgresCateringJobRepository(persistence.pool, {
    registry, auditRepository: persistence.auditRepository, auditService,
  });
  // Current production registration is manual only. This explicit empty adapter
  // resolver never fabricates API support, credentials, provider calls or success.
  const service = createCateringJobProcessor({ repository, registry, providers: { resolve: () => null } });
  const health = createHealthMonitor({ readinessChecks: persistence.readinessChecks });
  return createIntegrationJobWorker({ service,
    async runGate(work) {
      if (!(await health.evaluate()).ready) throw new Error('CATERING_JOB_NOT_READY');
      return work();
    },
    onResult: (result) => metrics.recordIntegrationJobBatch(result),
    onError() {
      try { metrics.recordIntegrationJobBatchFailure(); }
      finally { logger.lifecycle({ event: 'catering_job_processing_unavailable' }); }
    },
  });
}
