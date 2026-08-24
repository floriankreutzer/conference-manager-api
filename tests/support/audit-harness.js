import { createAuditService } from '../../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../../src/authorization/policy.js';

const DEFAULT_CLOCK = () => Date.parse('2026-08-24T09:00:00.000Z');
let correlationCounter = 1;

function nextCorrelationId() {
  const suffix = String(correlationCounter).padStart(12, '0');
  correlationCounter += 1;
  return `00000000-0000-4000-8000-${suffix}`;
}

export function createAuditHarness({
  authorizationPolicy = createAuthorizationPolicy(),
  clock = DEFAULT_CLOCK,
  verifyResult = true,
} = {}) {
  const events = [];
  const repository = {
    async append(event) {
      const stored = Object.freeze({
        id: String(events.length + 1),
        ...event,
        previousHash: null,
        eventHash: null,
        integrityVersion: 1,
      });
      events.push(stored);
      return stored;
    },
    async listByTenantId(tenantId, { limit = 50, beforeId = null } = {}) {
      const filtered = events
        .filter((event) => event.tenantId === tenantId)
        .filter((event) => beforeId === null || BigInt(event.id) < BigInt(beforeId))
        .slice()
        .reverse()
        .slice(0, limit);
      return Object.freeze(filtered);
    },
    async verifyTenantChain() {
      return verifyResult;
    },
  };
  return Object.freeze({
    events,
    repository,
    service: createAuditService({
      repository,
      authorizationPolicy,
      clock,
      correlationFactory: nextCorrelationId,
    }),
  });
}
