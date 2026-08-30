import {
  DEMO_FIXTURE,
  DEMO_FIXTURE_CHECKSUM,
  assertSemanticChecksum,
  validateDemoFixture,
} from './fixture.js';
import { isInternalUuid } from '../domain/identifiers.js';

function normalizeResetActor(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'assuranceLevel,operatorId,permissions,roles'
    || !isInternalUuid(value.operatorId)
    || !Array.isArray(value.roles)
    || value.roles.length < 1
    || value.roles.length > 4
    || value.roles.some((role) => typeof role !== 'string' || role.length > 64)
    || new Set(value.roles).size !== value.roles.length
    || !Array.isArray(value.permissions)
    || value.permissions.length < 1
    || value.permissions.length > 32
    || value.permissions.some((permission) => typeof permission !== 'string' || permission.length > 96)
    || new Set(value.permissions).size !== value.permissions.length
    || value.assuranceLevel !== 'step_up'
  ) throw new TypeError('DEMO_RESET_ACTOR_INVALID');
  return Object.freeze({
    operatorId: value.operatorId,
    roles: Object.freeze([...value.roles].sort()),
    permissions: Object.freeze([...value.permissions].sort()),
    assuranceLevel: value.assuranceLevel,
  });
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new TypeError('DEMO_RESET_CORRELATION_ID_INVALID');
  return value;
}

export class DemoResetServiceError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = 'DemoResetServiceError';
    this.code = code;
  }
}

export function createDemoResetService({
  repository,
  fixture = DEMO_FIXTURE,
  fixtureChecksum = DEMO_FIXTURE_CHECKSUM,
} = {}) {
  if (!repository || typeof repository.reset !== 'function') {
    throw new TypeError('DEMO_RESET_REPOSITORY_REQUIRED');
  }
  validateDemoFixture(fixture);
  assertSemanticChecksum(fixture, fixtureChecksum);

  return Object.freeze({
    descriptor: Object.freeze({
      seedVersion: fixture.seedVersion,
      checksum: fixtureChecksum,
    }),

    async reset({
      expectedChecksum = fixtureChecksum,
      correlationId = null,
      actor = null,
      auditEventFor = null,
    } = {}) {
      if (expectedChecksum !== fixtureChecksum) {
        throw new DemoResetServiceError('DEMO_RESET_CONFIRMATION_CHECKSUM_MISMATCH');
      }
      const resetActor = actor === null ? null : normalizeResetActor(actor);
      if ((resetActor === null) !== (correlationId === null)) {
        throw new TypeError('DEMO_RESET_AUDIT_CONTEXT_INCOMPLETE');
      }
      if ((resetActor === null) !== (auditEventFor === null)) {
        throw new TypeError('DEMO_RESET_AUDIT_FACTORY_INCOMPLETE');
      }
      if (auditEventFor !== null && typeof auditEventFor !== 'function') {
        throw new TypeError('DEMO_RESET_AUDIT_EVENT_FACTORY_INVALID');
      }
      if (resetActor !== null) requireCorrelationId(correlationId);
      validateDemoFixture(fixture);
      assertSemanticChecksum(fixture, fixtureChecksum);
      const result = await repository.reset({
        fixture,
        checksum: fixtureChecksum,
        auditEventFor: resetActor === null
          ? null
          : ({ outcome, reasonCode }) => auditEventFor({
            actor: resetActor,
            correlationId,
            outcome,
            reasonCode,
            seedVersion: fixture.seedVersion,
          }),
      });
      if (
        !result
        || result.seedVersion !== fixture.seedVersion
        || result.checksum !== fixtureChecksum
      ) throw new DemoResetServiceError('DEMO_RESET_RESULT_INVALID');
      return Object.freeze({
        seedVersion: result.seedVersion,
        checksum: result.checksum,
      });
    },
  });
}
