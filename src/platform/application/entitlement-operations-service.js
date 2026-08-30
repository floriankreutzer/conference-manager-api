import {
  authorizePlatformOperation,
  createMutationEvidence,
  inputError,
  PLATFORM_OPERATION,
  requireBoolean,
  requireBoundedText,
  requireClockTime,
  requireConfirmation,
  requireCursor,
  requireExactObject,
  requireInternalId,
  requireLimit,
  operationRequestDigest,
  requirePage,
  requirePort,
  requireReason,
  requireRevision,
  requireSafeCode,
  requireTimestamp,
} from './platform-operation-contract.js';
import {
  PlatformOperationConflictError,
  PlatformOperationUnavailableError,
} from './platform-operation-errors.js';
import {
  CapabilityDependencyPolicyError,
  requireCapabilityDependencyClosure,
} from '../../domain/capability-dependency-policy.js';

const TENANT_STATUSES = new Set(['pending', 'onboarding', 'ready', 'active', 'suspended', 'archived']);
const GRANT_STATUSES = new Set(['onboarding', 'ready', 'active']);
const PACKAGE_STATUSES = new Set(['active', 'retired']);
const MAX_CAPABILITIES = 64;

function unavailable(code) {
  throw new PlatformOperationUnavailableError(code);
}

function capabilityCatalogue(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CAPABILITIES) {
    unavailable('PLATFORM_CAPABILITY_CATALOGUE_INVALID');
  }
  const byId = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      unavailable('PLATFORM_CAPABILITY_CATALOGUE_INVALID');
    }
    const capabilityId = requireSafeCode(item.capabilityId, 'PLATFORM_CAPABILITY_CATALOGUE_INVALID');
    if (byId.has(capabilityId) || !Array.isArray(item.dependencies) || item.dependencies.length > MAX_CAPABILITIES) {
      unavailable('PLATFORM_CAPABILITY_CATALOGUE_INVALID');
    }
    const dependencies = Object.freeze(item.dependencies.map((dependency) => (
      requireSafeCode(dependency, 'PLATFORM_CAPABILITY_CATALOGUE_INVALID')
    )));
    if (new Set(dependencies).size !== dependencies.length || dependencies.includes(capabilityId)) {
      unavailable('PLATFORM_CAPABILITY_CATALOGUE_INVALID');
    }
    byId.set(capabilityId, Object.freeze({ capabilityId, dependencies }));
  }
  for (const capability of byId.values()) {
    if (capability.dependencies.some((dependency) => !byId.has(dependency))) {
      unavailable('PLATFORM_CAPABILITY_CATALOGUE_INVALID');
    }
  }
  for (const root of byId.keys()) {
    const visiting = new Set();
    const visited = new Set();
    const visit = (capabilityId) => {
      if (visiting.has(capabilityId)) unavailable('PLATFORM_CAPABILITY_CATALOGUE_INVALID');
      if (visited.has(capabilityId)) return;
      visiting.add(capabilityId);
      for (const dependency of byId.get(capabilityId).dependencies) visit(dependency);
      visiting.delete(capabilityId);
      visited.add(capabilityId);
    };
    visit(root);
  }
  return byId;
}

function publicCapabilities(catalogue) {
  return Object.freeze([...catalogue.values()]
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))
    .map((value) => Object.freeze({
      capabilityId: value.capabilityId,
      dependencies: value.dependencies,
    })));
}

function requireTenantStatus(value, code = 'PLATFORM_ENTITLEMENT_STATE_INVALID') {
  if (typeof value !== 'string' || !TENANT_STATUSES.has(value)) unavailable(code);
  return value;
}

function normalizeProposals(value, catalogue, code = 'PLATFORM_ENTITLEMENT_PROPOSAL_INVALID') {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CAPABILITIES) throw inputError(code);
  const seen = new Set();
  return Object.freeze(value.map((proposal) => {
    requireExactObject(proposal, ['capabilityId', 'enabled'], ['capabilityId', 'enabled'], code);
    const capabilityId = requireSafeCode(proposal.capabilityId, code);
    if (!catalogue.has(capabilityId) || seen.has(capabilityId)) throw inputError(code);
    seen.add(capabilityId);
    return Object.freeze({ capabilityId, enabled: requireBoolean(proposal.enabled, code) });
  }));
}

function tenantState(value, tenantId, catalogue) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.entries)) {
    unavailable('PLATFORM_ENTITLEMENT_STATE_INVALID');
  }
  if (requireInternalId(value.tenantId, 'PLATFORM_ENTITLEMENT_STATE_INVALID') !== tenantId) {
    unavailable('PLATFORM_ENTITLEMENT_STATE_INVALID');
  }
  const entries = new Map();
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      unavailable('PLATFORM_ENTITLEMENT_STATE_INVALID');
    }
    const capabilityId = requireSafeCode(entry.capabilityId, 'PLATFORM_ENTITLEMENT_STATE_INVALID');
    if (!catalogue.has(capabilityId) || entries.has(capabilityId)) unavailable('PLATFORM_ENTITLEMENT_STATE_INVALID');
    entries.set(capabilityId, Object.freeze({
      capabilityId,
      enabled: typeof entry.enabled === 'boolean'
        ? entry.enabled
        : unavailable('PLATFORM_ENTITLEMENT_STATE_INVALID'),
      effectiveAt: entry.effectiveAt === null
        ? null
        : requireTimestamp(entry.effectiveAt, 'PLATFORM_ENTITLEMENT_STATE_INVALID'),
    }));
  }
  for (const capabilityId of catalogue.keys()) {
    if (!entries.has(capabilityId)) {
      entries.set(capabilityId, Object.freeze({ capabilityId, enabled: false, effectiveAt: null }));
    }
  }
  return Object.freeze({
    tenantId,
    tenantStatus: requireTenantStatus(value.tenantStatus),
    revision: requireRevision(value.revision, 'PLATFORM_ENTITLEMENT_STATE_INVALID'),
    entries,
  });
}

function publicTenantState(state) {
  return Object.freeze({
    tenantId: state.tenantId,
    tenantStatus: state.tenantStatus,
    revision: state.revision,
    entries: Object.freeze([...state.entries.values()]
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))),
  });
}

function validateDependencies(candidate, catalogue) {
  try {
    requireCapabilityDependencyClosure(
      [...candidate].map(([capabilityId, enabled]) => ({ capabilityId, enabled })),
      [...catalogue.values()],
    );
  } catch (error) {
    if (
      error instanceof CapabilityDependencyPolicyError
      && error.code === 'CAPABILITY_DEPENDENCY_MISSING'
    ) {
      throw new PlatformOperationConflictError('PLATFORM_ENTITLEMENT_DEPENDENCY_MISSING');
    }
    throw error;
  }
}

function planChanges(state, proposals, catalogue) {
  const candidate = new Map([...state.entries].map(([capabilityId, entry]) => [capabilityId, entry.enabled]));
  for (const proposal of proposals) candidate.set(proposal.capabilityId, proposal.enabled);
  validateDependencies(candidate, catalogue);
  const changes = Object.freeze(proposals
    .filter((proposal) => state.entries.get(proposal.capabilityId).enabled !== proposal.enabled)
    .map((proposal) => Object.freeze({
      capabilityId: proposal.capabilityId,
      previousEnabled: state.entries.get(proposal.capabilityId).enabled,
      enabled: proposal.enabled,
    })));
  if (state.tenantStatus === 'archived' && changes.length > 0) {
    throw new PlatformOperationConflictError('PLATFORM_ENTITLEMENT_TENANT_ARCHIVED');
  }
  if (!GRANT_STATUSES.has(state.tenantStatus) && changes.some((change) => change.enabled)) {
    throw new PlatformOperationConflictError('PLATFORM_ENTITLEMENT_GRANT_LIFECYCLE_DENIED');
  }
  return Object.freeze({
    tenantId: state.tenantId,
    tenantStatus: state.tenantStatus,
    sourceRevision: state.revision,
    changed: changes.length > 0,
    changes,
  });
}

function packageRecord(value, catalogue, { includeTemplate = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_PACKAGE_INVALID');
  const status = typeof value.status === 'string' && PACKAGE_STATUSES.has(value.status)
    ? value.status
    : unavailable('PLATFORM_PACKAGE_INVALID');
  const result = {
    packageId: requireSafeCode(value.packageId, 'PLATFORM_PACKAGE_INVALID'),
    revision: requireRevision(value.revision, 'PLATFORM_PACKAGE_INVALID'),
    name: requireBoundedText(value.name, { maximum: 120, code: 'PLATFORM_PACKAGE_INVALID' }),
    description: requireBoundedText(value.description, {
      minimum: 0,
      maximum: 500,
      code: 'PLATFORM_PACKAGE_INVALID',
    }),
    status,
  };
  if (includeTemplate) {
    result.proposals = normalizeProposals(value.proposals, catalogue, 'PLATFORM_PACKAGE_INVALID');
  }
  return Object.freeze(result);
}

function requirePreviewInput(value, { packageInput = false } = {}) {
  const keys = packageInput
    ? ['operatorContext', 'tenantId', 'packageId']
    : ['operatorContext', 'tenantId', 'proposals'];
  requireExactObject(value, keys);
  return Object.freeze({
    operatorContext: value.operatorContext,
    tenantId: requireInternalId(value.tenantId, 'PLATFORM_TENANT_ID_INVALID'),
    ...(packageInput
      ? { packageId: requireSafeCode(value.packageId, 'PLATFORM_PACKAGE_ID_INVALID') }
      : { proposals: value.proposals }),
  });
}

function requireApplyInput(value, { packageInput = false } = {}) {
  const keys = [
    'operatorContext',
    'tenantId',
    packageInput ? 'packageId' : 'proposals',
    ...(packageInput ? ['expectedPackageRevision'] : []),
    'expectedEntitlementRevision',
    'reason',
    'confirmation',
    'correlationId',
    'idempotencyKey',
  ];
  requireExactObject(value, keys);
  const tenantId = requireInternalId(value.tenantId, 'PLATFORM_TENANT_ID_INVALID');
  return Object.freeze({
    operatorContext: value.operatorContext,
    tenantId,
    ...(packageInput
      ? {
        packageId: requireSafeCode(value.packageId, 'PLATFORM_PACKAGE_ID_INVALID'),
        expectedPackageRevision: requireRevision(value.expectedPackageRevision),
      }
      : { proposals: value.proposals }),
    expectedEntitlementRevision: requireRevision(value.expectedEntitlementRevision),
    reason: requireReason(value.reason),
    confirmation: requireConfirmation(value.confirmation, {
      action: PLATFORM_OPERATION.ENTITLEMENT_APPLY,
      tenantId,
    }),
    correlationId: requireInternalId(value.correlationId, 'PLATFORM_CORRELATION_ID_INVALID'),
    idempotencyKey: requireInternalId(value.idempotencyKey, 'PLATFORM_IDEMPOTENCY_KEY_INVALID'),
  });
}

export function createPlatformEntitlementOperationsService({
  capabilityPolicy,
  packageReader,
  entitlementReader,
  entitlementTransactions,
  operationReceiptReader,
  platformAuthorizationPolicy,
  tenantTargetPolicy,
  operationEvidenceFactory,
  clock = () => Date.now(),
} = {}) {
  requirePort(capabilityPolicy, ['list'], 'PLATFORM_CAPABILITY_POLICY_REQUIRED');
  requirePort(packageReader, ['list', 'findById'], 'PLATFORM_PACKAGE_READER_REQUIRED');
  requirePort(entitlementReader, ['findTenantState'], 'PLATFORM_ENTITLEMENT_READER_REQUIRED');
  requirePort(entitlementTransactions, ['apply'], 'PLATFORM_ENTITLEMENT_TRANSACTIONS_REQUIRED');
  requirePort(operationReceiptReader, ['find'], 'PLATFORM_OPERATION_RECEIPT_READER_REQUIRED');
  requirePort(platformAuthorizationPolicy, ['authorize'], 'PLATFORM_AUTHORIZATION_POLICY_REQUIRED');
  requirePort(tenantTargetPolicy, ['authorize', 'queryScope'], 'PLATFORM_TENANT_TARGET_POLICY_REQUIRED');
  requirePort(operationEvidenceFactory, ['createMutation'], 'PLATFORM_OPERATION_EVIDENCE_FACTORY_REQUIRED');
  if (typeof clock !== 'function') throw new TypeError('PLATFORM_OPERATION_CLOCK_REQUIRED');

  async function catalogue() {
    return capabilityCatalogue(await capabilityPolicy.list());
  }

  async function loadState(tenantId, capabilities) {
    const value = await entitlementReader.findTenantState(tenantId);
    if (!value) throw new PlatformOperationConflictError('PLATFORM_TENANT_NOT_FOUND');
    return tenantState(value, tenantId, capabilities);
  }

  async function authorizeRead(operatorContext, tenantId = null) {
    return authorizePlatformOperation({
      authorizationPolicy: platformAuthorizationPolicy,
      tenantTargetPolicy,
      operatorContext,
      operation: PLATFORM_OPERATION.ENTITLEMENT_READ,
      tenantId,
      fleet: tenantId === null,
    });
  }

  async function packagePlan(values, capabilities) {
    const [state, rawPackage] = await Promise.all([
      loadState(values.tenantId, capabilities),
      packageReader.findById(values.packageId),
    ]);
    if (!rawPackage) throw new PlatformOperationConflictError('PLATFORM_PACKAGE_NOT_FOUND');
    const packageValue = packageRecord(rawPackage, capabilities, { includeTemplate: true });
    if (packageValue.packageId !== values.packageId || packageValue.status !== 'active') {
      throw new PlatformOperationConflictError('PLATFORM_PACKAGE_NOT_ACTIVE');
    }
    return Object.freeze({
      state,
      packageValue,
      plan: planChanges(state, packageValue.proposals, capabilities),
    });
  }

  function requestDigestFor(values, proposals, packageRevision = null) {
    return operationRequestDigest({
      operation: PLATFORM_OPERATION.ENTITLEMENT_APPLY,
      tenantId: values.tenantId,
      expectedEntitlementRevision: values.expectedEntitlementRevision,
      packageId: values.packageId ?? null,
      expectedPackageRevision: packageRevision,
      proposals,
      reason: values.reason,
    });
  }

  async function entitlementReplay(values, capabilities, authorization, requestDigest) {
    const replay = await operationReceiptReader.find({
      authorization,
      operation: PLATFORM_OPERATION.ENTITLEMENT_APPLY,
      tenantId: values.tenantId,
      idempotencyKey: values.idempotencyKey,
    });
    if (replay) {
      if (replay.requestDigest !== requestDigest) {
        throw new PlatformOperationConflictError('PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
      }
      const replayed = tenantState(replay.result?.entitlements, values.tenantId, capabilities);
      return Object.freeze({
        schemaVersion: 1,
        outcome: 'idempotent',
        entitlements: publicTenantState(replayed),
      });
    }
    return null;
  }

  async function apply(values, state, plan, capabilities, authorization, requestDigest, packageValue = null) {
    if (state.revision !== values.expectedEntitlementRevision) {
      throw new PlatformOperationConflictError('PLATFORM_ENTITLEMENT_REVISION_STALE');
    }
    if (packageValue && packageValue.revision !== values.expectedPackageRevision) {
      throw new PlatformOperationConflictError('PLATFORM_PACKAGE_REVISION_STALE');
    }
    if (!plan.changed) {
      return Object.freeze({
        schemaVersion: 1,
        outcome: 'unchanged',
        entitlements: publicTenantState(state),
      });
    }
    const occurredAt = new Date(requireClockTime(clock)).toISOString();
    const evidence = await createMutationEvidence({
      evidenceFactory: operationEvidenceFactory,
      authorization,
      operation: PLATFORM_OPERATION.ENTITLEMENT_APPLY,
      tenantId: values.tenantId,
      correlationId: values.correlationId,
      reason: values.reason,
      target: Object.freeze({
        type: packageValue ? 'tenant_entitlement_package' : 'tenant_entitlements',
        id: packageValue ? packageValue.packageId : values.tenantId,
      }),
      previousState: Object.freeze({
        revision: state.revision,
        capabilities: Object.freeze(plan.changes.map((change) => Object.freeze({
          capabilityId: change.capabilityId,
          enabled: change.previousEnabled,
        }))),
      }),
      requestedState: Object.freeze({
        capabilities: Object.freeze(plan.changes.map((change) => Object.freeze({
          capabilityId: change.capabilityId,
          enabled: change.enabled,
        }))),
      }),
      occurredAt,
    });
    const result = await entitlementTransactions.apply({
      tenantId: values.tenantId,
      expectedEntitlementRevision: values.expectedEntitlementRevision,
      expectedTenantStatus: state.tenantStatus,
      packageId: packageValue?.packageId ?? null,
      expectedPackageRevision: packageValue?.revision ?? null,
      changes: plan.changes,
      reason: values.reason,
      correlationId: values.correlationId,
      idempotencyKey: values.idempotencyKey,
      authorization,
      evidence,
      occurredAt,
      requestDigest,
    });
    if (result?.outcome === 'stale' || result?.outcome === 'package_stale') {
      throw new PlatformOperationConflictError(
        result.outcome === 'package_stale'
          ? 'PLATFORM_PACKAGE_REVISION_STALE'
          : 'PLATFORM_ENTITLEMENT_REVISION_STALE',
      );
    }
    if (result?.outcome === 'idempotency_conflict') {
      throw new PlatformOperationConflictError('PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
    }
    if (!result || !['updated', 'idempotent'].includes(result.outcome)) {
      throw new PlatformOperationUnavailableError('PLATFORM_ENTITLEMENT_TRANSACTION_RESULT_INVALID');
    }
    const updated = tenantState(result.entitlements, values.tenantId, capabilities);
    return Object.freeze({ schemaVersion: 1, outcome: result.outcome, entitlements: publicTenantState(updated) });
  }

  return Object.freeze({
    async listCapabilities(input) {
      requireExactObject(input, ['operatorContext']);
      await authorizeRead(input.operatorContext);
      return Object.freeze({
        schemaVersion: 1,
        items: publicCapabilities(await catalogue()),
      });
    },

    async listPackages(input) {
      requireExactObject(input, ['operatorContext', 'query']);
      requireExactObject(input.query, ['limit', 'cursor'], [], 'PLATFORM_PACKAGE_QUERY_INVALID');
      const query = Object.freeze({
        limit: requireLimit(input.query.limit),
        cursor: input.query.cursor === undefined ? null : requireCursor(input.query.cursor),
      });
      const authorization = await authorizeRead(input.operatorContext);
      const capabilities = await catalogue();
      const page = requirePage(await packageReader.list({ query, authorization }));
      if (page.items.length > query.limit) unavailable('PLATFORM_PACKAGE_PAGE_INVALID');
      return Object.freeze({
        schemaVersion: 1,
        snapshotAt: page.snapshotAt,
        items: Object.freeze(page.items.map((item) => packageRecord(item, capabilities))),
        nextCursor: page.nextCursor,
      });
    },

    async getTenantEntitlements(input) {
      requireExactObject(input, ['operatorContext', 'tenantId']);
      const tenantId = requireInternalId(input.tenantId, 'PLATFORM_TENANT_ID_INVALID');
      await authorizeRead(input.operatorContext, tenantId);
      const capabilities = await catalogue();
      const state = await loadState(tenantId, capabilities);
      return Object.freeze({ schemaVersion: 1, entitlements: publicTenantState(state) });
    },

    async previewEntitlementChanges(input) {
      const values = requirePreviewInput(input);
      await authorizeRead(values.operatorContext, values.tenantId);
      const capabilities = await catalogue();
      const state = await loadState(values.tenantId, capabilities);
      const proposals = normalizeProposals(values.proposals, capabilities);
      return Object.freeze({
        schemaVersion: 1,
        source: 'direct',
        plan: planChanges(state, proposals, capabilities),
      });
    },

    async previewPackage(input) {
      const values = requirePreviewInput(input, { packageInput: true });
      await authorizeRead(values.operatorContext, values.tenantId);
      const capabilities = await catalogue();
      const { packageValue, plan } = await packagePlan(values, capabilities);
      return Object.freeze({
        schemaVersion: 1,
        source: 'package',
        package: Object.freeze({
          packageId: packageValue.packageId,
          revision: packageValue.revision,
          name: packageValue.name,
          description: packageValue.description,
        }),
        plan,
      });
    },

    async applyEntitlementChanges(input) {
      const values = requireApplyInput(input);
      const authorization = await authorizePlatformOperation({
        authorizationPolicy: platformAuthorizationPolicy,
        tenantTargetPolicy,
        operatorContext: values.operatorContext,
        operation: PLATFORM_OPERATION.ENTITLEMENT_APPLY,
        tenantId: values.tenantId,
      });
      const capabilities = await catalogue();
      const proposals = normalizeProposals(values.proposals, capabilities);
      const requestDigest = requestDigestFor(values, proposals, null);
      const replay = await entitlementReplay(values, capabilities, authorization, requestDigest);
      if (replay) return replay;
      const state = await loadState(values.tenantId, capabilities);
      return apply(
        values,
        state,
        planChanges(state, proposals, capabilities),
        capabilities,
        authorization,
        requestDigest,
      );
    },

    async applyPackage(input) {
      const values = requireApplyInput(input, { packageInput: true });
      const authorization = await authorizePlatformOperation({
        authorizationPolicy: platformAuthorizationPolicy,
        tenantTargetPolicy,
        operatorContext: values.operatorContext,
        operation: PLATFORM_OPERATION.ENTITLEMENT_APPLY,
        tenantId: values.tenantId,
      });
      const capabilities = await catalogue();
      const requestDigest = requestDigestFor(values, null, values.expectedPackageRevision);
      const replay = await entitlementReplay(values, capabilities, authorization, requestDigest);
      if (replay) return replay;
      const { state, packageValue, plan } = await packagePlan(values, capabilities);
      return apply(values, state, plan, capabilities, authorization, requestDigest, packageValue);
    },
  });
}
