import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PILOT_EVIDENCE_ID,
  PILOT_EVIDENCE_IDS,
  validatePilotReadinessEvidence,
} from '../src/operator/pilot-readiness-evidence.js';

const VERIFIED_AT = '2026-08-26T09:00:00.000Z';
const CONDITIONAL = new Set([
  PILOT_EVIDENCE_ID.GRAPH_CALENDAR_WRITE,
  PILOT_EVIDENCE_ID.EXCHANGE_APPLICATION_RBAC,
]);

function item(id, calendarWrite) {
  if (calendarWrite === 'disabled' && CONDITIONAL.has(id)) {
    return {
      id,
      status: 'not_applicable',
      reference: null,
      verifiedAt: null,
      note: 'The capability is disabled by the Pilot release decision.',
    };
  }
  return {
    id,
    status: 'verified',
    reference: `evidence:${id}`,
    verifiedAt: VERIFIED_AT,
    note: null,
  };
}

function evidenceDocument({ calendarWrite = 'disabled', generatedAt = VERIFIED_AT } = {}) {
  return {
    schemaVersion: 1,
    environment: 'pilot',
    calendarWrite,
    generatedAt,
    release: {
      backendCommit: 'a'.repeat(40),
      frontendCommit: 'b'.repeat(40),
    },
    evidence: PILOT_EVIDENCE_IDS.map((id) => item(id, calendarWrite)),
  };
}

function replaceEvidence(document, id, replacement) {
  return {
    ...document,
    evidence: document.evidence.map((entry) => entry.id === id ? replacement : entry),
  };
}

test('disabled Calendar Write can validate its declared scope but is not enabled-write evidence for issue #73', () => {
  const result = validatePilotReadinessEvidence(evidenceDocument(), { requireReady: true });
  assert.equal(result.summary.ready, true);
  assert.equal(result.summary.enabledCalendarWriteEvidenceVerified, false);
  assert.equal(result.summary.pending.length, 0);
  assert.deepEqual(result.summary.notApplicable, [
    PILOT_EVIDENCE_ID.GRAPH_CALENDAR_WRITE,
    PILOT_EVIDENCE_ID.EXCHANGE_APPLICATION_RBAC,
  ].sort());
});

test('enabled Calendar Write requires both live write and Exchange RBAC evidence', () => {
  const result = validatePilotReadinessEvidence(
    evidenceDocument({ calendarWrite: 'enabled' }),
    { requireReady: true },
  );
  assert.equal(result.summary.ready, true);
  assert.equal(result.summary.enabledCalendarWriteEvidenceVerified, true);
  assert.equal(result.summary.notApplicable.length, 0);

  const invalid = replaceEvidence(
    evidenceDocument({ calendarWrite: 'enabled' }),
    PILOT_EVIDENCE_ID.EXCHANGE_APPLICATION_RBAC,
    {
      id: PILOT_EVIDENCE_ID.EXCHANGE_APPLICATION_RBAC,
      status: 'not_applicable',
      reference: null,
      verifiedAt: null,
      note: 'Incorrectly omitted.',
    },
  );
  assert.throws(
    () => validatePilotReadinessEvidence(invalid),
    (error) => error?.code === 'PILOT_READINESS_ENABLED_CAPABILITY_EVIDENCE_REQUIRED',
  );
});

test('pending external evidence is valid as a document but cannot release the Pilot', () => {
  const pendingItem = {
    id: PILOT_EVIDENCE_ID.TWO_ENTRA_TENANTS,
    status: 'pending',
    reference: null,
    verifiedAt: null,
    note: 'The second independent organization has not completed acceptance.',
  };
  const pending = replaceEvidence(
    evidenceDocument(),
    PILOT_EVIDENCE_ID.TWO_ENTRA_TENANTS,
    pendingItem,
  );
  const result = validatePilotReadinessEvidence(pending);
  assert.equal(result.summary.ready, false);
  assert.deepEqual(result.summary.pending, [PILOT_EVIDENCE_ID.TWO_ENTRA_TENANTS]);
  assert.throws(
    () => validatePilotReadinessEvidence(pending, { requireReady: true }),
    (error) => error?.code === 'PILOT_READINESS_PENDING',
  );
});

test('required evidence cannot be hidden as not applicable', () => {
  const invalid = replaceEvidence(
    evidenceDocument(),
    PILOT_EVIDENCE_ID.BACKUP_RESTORE,
    {
      id: PILOT_EVIDENCE_ID.BACKUP_RESTORE,
      status: 'not_applicable',
      reference: null,
      verifiedAt: null,
      note: 'Incorrectly omitted.',
    },
  );
  assert.throws(
    () => validatePilotReadinessEvidence(invalid),
    (error) => error?.code === 'PILOT_READINESS_REQUIRED_EVIDENCE_NOT_APPLICABLE',
  );
});

test('duplicate, unknown and incomplete release evidence fail closed', () => {
  const duplicate = evidenceDocument();
  duplicate.evidence[duplicate.evidence.length - 1] = {
    ...duplicate.evidence[0],
  };
  assert.throws(
    () => validatePilotReadinessEvidence(duplicate),
    (error) => error?.code === 'PILOT_READINESS_EVIDENCE_DUPLICATE',
  );

  const unknown = evidenceDocument();
  unknown.evidence[0] = { ...unknown.evidence[0], id: 'unknown.evidence' };
  assert.throws(
    () => validatePilotReadinessEvidence(unknown),
    (error) => error?.code === 'PILOT_READINESS_EVIDENCE_UNKNOWN',
  );

  const incompleteRelease = evidenceDocument();
  incompleteRelease.release.frontendCommit = null;
  assert.throws(
    () => validatePilotReadinessEvidence(incompleteRelease),
    (error) => error?.code === 'PILOT_READINESS_RELEASE_INCOMPLETE',
  );
});

test('evidence references reject credential, session, identifier and raw token material', () => {
  const sensitiveReferences = [
    'Bearer abcdefghijklmnop',
    'client_secret=do-not-store-this',
    'cm_session=do-not-store-this',
    'A'.repeat(43),
    'artifact:11111111-1111-4111-8111-111111111111',
    'oid=customer-object-reference',
    'tid=customer-tenant-reference',
  ];
  for (const reference of sensitiveReferences) {
    const invalid = replaceEvidence(
      evidenceDocument(),
      PILOT_EVIDENCE_ID.BACKEND_GATES,
      {
        id: PILOT_EVIDENCE_ID.BACKEND_GATES,
        status: 'verified',
        reference,
        verifiedAt: VERIFIED_AT,
        note: null,
      },
    );
    assert.throws(
      () => validatePilotReadinessEvidence(invalid),
      (error) => error?.code === 'PILOT_READINESS_REFERENCE_INVALID',
    );
  }
});

test('evidence notes reject naked UUID identifiers', () => {
  const invalid = replaceEvidence(
    evidenceDocument(),
    PILOT_EVIDENCE_ID.BACKEND_GATES,
    {
      id: PILOT_EVIDENCE_ID.BACKEND_GATES,
      status: 'verified',
      reference: 'protected-backend-gate-report',
      verifiedAt: VERIFIED_AT,
      note: 'Protected artifact 11111111-1111-4111-8111-111111111111 was reviewed.',
    },
  );
  assert.throws(
    () => validatePilotReadinessEvidence(invalid),
    (error) => error?.code === 'PILOT_READINESS_NOTE_INVALID',
  );
});

test('unexpected fields and unverified references are rejected', () => {
  const unexpected = evidenceDocument();
  unexpected.browserAuthority = true;
  assert.throws(
    () => validatePilotReadinessEvidence(unexpected),
    (error) => error?.code === 'PILOT_READINESS_DOCUMENT_INVALID',
  );

  const pendingWithReference = replaceEvidence(
    evidenceDocument(),
    PILOT_EVIDENCE_ID.DEPLOYED_DAST,
    {
      id: PILOT_EVIDENCE_ID.DEPLOYED_DAST,
      status: 'pending',
      reference: 'not-yet-executed',
      verifiedAt: null,
      note: 'A reference cannot be attached before execution.',
    },
  );
  assert.throws(
    () => validatePilotReadinessEvidence(pendingWithReference),
    (error) => error?.code === 'PILOT_READINESS_UNVERIFIED_REFERENCE_PROHIBITED',
  );
});
