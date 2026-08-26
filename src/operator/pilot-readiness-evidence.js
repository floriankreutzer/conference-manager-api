const EVIDENCE_STATUS = Object.freeze({
  VERIFIED: 'verified',
  PENDING: 'pending',
  NOT_APPLICABLE: 'not_applicable',
});
const CALENDAR_WRITE_STATE = Object.freeze({
  ENABLED: 'enabled',
  DISABLED: 'disabled',
});

export const PILOT_EVIDENCE_ID = Object.freeze({
  BACKEND_GATES: 'repository.backend_gates',
  FRONTEND_GATES: 'repository.frontend_gates',
  MULTI_TENANT: 'security.multi_tenant',
  PROVIDER_REGION_DECISION: 'deployment.provider_region_decision',
  EU_RUNTIME: 'deployment.eu_runtime',
  HTTPS: 'deployment.https',
  POSTGRESQL_18: 'deployment.postgresql18',
  BACKUP_RESTORE: 'operations.backup_restore',
  ROLLBACK: 'operations.rollback',
  TWO_ENTRA_TENANTS: 'acceptance.two_entra_tenants',
  OIDC_SESSION: 'acceptance.oidc_session',
  GRAPH_PLACES: 'acceptance.graph_places',
  GRAPH_FREE_BUSY: 'acceptance.graph_free_busy',
  GRAPH_CALENDAR_WRITE: 'acceptance.graph_calendar_write',
  EXCHANGE_APPLICATION_RBAC: 'security.exchange_application_rbac',
  BROWSER_E2E: 'acceptance.browser_e2e',
  DEPLOYED_DAST: 'security.deployed_dast',
  PENETRATION_TEST: 'security.penetration_test',
  REDACTION: 'security.redaction',
  OBSERVABILITY: 'operations.observability',
});

export const PILOT_EVIDENCE_IDS = Object.freeze(Object.values(PILOT_EVIDENCE_ID));

const KNOWN_IDS = new Set(PILOT_EVIDENCE_IDS);
const CONDITIONAL_IDS = new Set([
  PILOT_EVIDENCE_ID.GRAPH_CALENDAR_WRITE,
  PILOT_EVIDENCE_ID.EXCHANGE_APPLICATION_RBAC,
]);
const STATUS_VALUES = new Set(Object.values(EVIDENCE_STATUS));
const CALENDAR_WRITE_VALUES = new Set(Object.values(CALENDAR_WRITE_STATE));
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const UUID_MATERIAL = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const FORBIDDEN_MATERIAL = [
  /(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}/i,
  /(?:access|refresh|id)[_-]?token\s*[:=]/i,
  /client[_-]?secret\s*[:=]/i,
  /cm_(?:session|tenant_claim)\s*=/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b[A-Za-z0-9_-]{43}\b/,
  /(?:provider[_-]?)?tenant[_-]?id\s*[:=]/i,
  /(?:user|object|provider|integration|correlation|session)[_-]?id\s*[:=]/i,
  /\b(?:tid|oid)\s*[:=]/i,
  UUID_MATERIAL,
];

export class PilotReadinessEvidenceError extends Error {
  constructor(code = 'PILOT_READINESS_EVIDENCE_INVALID') {
    super(code);
    this.name = 'PilotReadinessEvidenceError';
    this.code = code;
  }
}

function invalid(code) {
  throw new PilotReadinessEvidenceError(code);
}

function exactObject(value, expectedKeys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(code);
  }
}

function validUtcInstant(value) {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

function safeText(value, { max, required, code }) {
  if (value === null && required !== true) return null;
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > max
    || value.trim() !== value
    || CONTROL_CHARACTER.test(value)
    || FORBIDDEN_MATERIAL.some((pattern) => pattern.test(value))
  ) {
    invalid(code);
  }
  return value;
}

function normalizedCommit(value) {
  if (value === null) return null;
  if (!COMMIT_PATTERN.test(value) || /^0+$/.test(value)) invalid('PILOT_READINESS_COMMIT_INVALID');
  return value;
}

function normalizeRelease(value) {
  exactObject(
    value,
    ['backendCommit', 'frontendCommit'],
    'PILOT_READINESS_RELEASE_INVALID',
  );
  const backendCommit = normalizedCommit(value.backendCommit);
  const frontendCommit = normalizedCommit(value.frontendCommit);
  if ((backendCommit === null) !== (frontendCommit === null)) {
    invalid('PILOT_READINESS_RELEASE_INCOMPLETE');
  }
  return Object.freeze({ backendCommit, frontendCommit });
}

function normalizeEvidenceItem(value, calendarWrite) {
  exactObject(
    value,
    ['id', 'status', 'reference', 'verifiedAt', 'note'],
    'PILOT_READINESS_ITEM_INVALID',
  );
  if (!KNOWN_IDS.has(value.id)) invalid('PILOT_READINESS_EVIDENCE_UNKNOWN');
  if (!STATUS_VALUES.has(value.status)) invalid('PILOT_READINESS_STATUS_INVALID');

  const conditional = CONDITIONAL_IDS.has(value.id);
  if (!conditional && value.status === EVIDENCE_STATUS.NOT_APPLICABLE) {
    invalid('PILOT_READINESS_REQUIRED_EVIDENCE_NOT_APPLICABLE');
  }
  if (
    conditional
    && calendarWrite === CALENDAR_WRITE_STATE.DISABLED
    && value.status !== EVIDENCE_STATUS.NOT_APPLICABLE
  ) {
    invalid('PILOT_READINESS_DISABLED_CAPABILITY_EVIDENCE_INVALID');
  }
  if (
    conditional
    && calendarWrite === CALENDAR_WRITE_STATE.ENABLED
    && value.status === EVIDENCE_STATUS.NOT_APPLICABLE
  ) {
    invalid('PILOT_READINESS_ENABLED_CAPABILITY_EVIDENCE_REQUIRED');
  }

  if (value.status === EVIDENCE_STATUS.VERIFIED) {
    const reference = safeText(value.reference, {
      max: 1_000,
      required: true,
      code: 'PILOT_READINESS_REFERENCE_INVALID',
    });
    if (!validUtcInstant(value.verifiedAt)) invalid('PILOT_READINESS_VERIFIED_AT_INVALID');
    const note = safeText(value.note, {
      max: 500,
      required: false,
      code: 'PILOT_READINESS_NOTE_INVALID',
    });
    return Object.freeze({
      id: value.id,
      status: value.status,
      reference,
      verifiedAt: value.verifiedAt,
      note,
    });
  }

  if (value.reference !== null || value.verifiedAt !== null) {
    invalid('PILOT_READINESS_UNVERIFIED_REFERENCE_PROHIBITED');
  }
  const note = safeText(value.note, {
    max: 500,
    required: true,
    code: 'PILOT_READINESS_NOTE_REQUIRED',
  });
  return Object.freeze({
    id: value.id,
    status: value.status,
    reference: null,
    verifiedAt: null,
    note,
  });
}

export function validatePilotReadinessEvidence(value, { requireReady = false } = {}) {
  exactObject(
    value,
    ['schemaVersion', 'environment', 'calendarWrite', 'generatedAt', 'release', 'evidence'],
    'PILOT_READINESS_DOCUMENT_INVALID',
  );
  if (value.schemaVersion !== 1) invalid('PILOT_READINESS_SCHEMA_UNSUPPORTED');
  if (value.environment !== 'pilot') invalid('PILOT_READINESS_ENVIRONMENT_INVALID');
  if (!CALENDAR_WRITE_VALUES.has(value.calendarWrite)) {
    invalid('PILOT_READINESS_CALENDAR_WRITE_INVALID');
  }
  if (value.generatedAt !== null && !validUtcInstant(value.generatedAt)) {
    invalid('PILOT_READINESS_GENERATED_AT_INVALID');
  }
  const release = normalizeRelease(value.release);
  if (!Array.isArray(value.evidence) || value.evidence.length !== PILOT_EVIDENCE_IDS.length) {
    invalid('PILOT_READINESS_EVIDENCE_SET_INVALID');
  }

  const seen = new Set();
  const evidence = value.evidence.map((item) => {
    const normalized = normalizeEvidenceItem(item, value.calendarWrite);
    if (seen.has(normalized.id)) invalid('PILOT_READINESS_EVIDENCE_DUPLICATE');
    seen.add(normalized.id);
    return normalized;
  });
  if (PILOT_EVIDENCE_IDS.some((id) => !seen.has(id))) {
    invalid('PILOT_READINESS_EVIDENCE_MISSING');
  }

  const pending = evidence
    .filter((item) => item.status === EVIDENCE_STATUS.PENDING)
    .map((item) => item.id)
    .sort();
  const notApplicable = evidence
    .filter((item) => item.status === EVIDENCE_STATUS.NOT_APPLICABLE)
    .map((item) => item.id)
    .sort();
  const ready = pending.length === 0
    && release.backendCommit !== null
    && value.generatedAt !== null;
  const enabledCalendarWriteEvidenceVerified = value.calendarWrite === CALENDAR_WRITE_STATE.ENABLED
    && evidence.find((item) => item.id === PILOT_EVIDENCE_ID.GRAPH_CALENDAR_WRITE)?.status
      === EVIDENCE_STATUS.VERIFIED
    && evidence.find((item) => item.id === PILOT_EVIDENCE_ID.EXCHANGE_APPLICATION_RBAC)?.status
      === EVIDENCE_STATUS.VERIFIED;
  if (requireReady && !ready) invalid('PILOT_READINESS_PENDING');

  return Object.freeze({
    schemaVersion: 1,
    environment: value.environment,
    calendarWrite: value.calendarWrite,
    generatedAt: value.generatedAt,
    release,
    evidence: Object.freeze(evidence),
    summary: Object.freeze({
      ready,
      enabledCalendarWriteEvidenceVerified,
      verifiedCount: evidence.filter((item) => item.status === EVIDENCE_STATUS.VERIFIED).length,
      pending: Object.freeze(pending),
      notApplicable: Object.freeze(notApplicable),
    }),
  });
}

export const PILOT_EVIDENCE_STATUS = EVIDENCE_STATUS;
export const PILOT_CALENDAR_WRITE_STATE = CALENDAR_WRITE_STATE;
