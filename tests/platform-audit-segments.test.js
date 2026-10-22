import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSegmentSigners,createSegmentRowVerifier,normalizeAuditSegment,
  createPlatformAuditRowVerifier } from '../src/persistence/postgres/platform-audit-integrity.js';
import { normalizePlatformAuditSegmentRequest } from '../src/operator/platform-audit-segment-request.js';
import { normalizePlatformAuditEvent } from '../src/platform/audit/event.js';
import { projectPlatformAuditVerification } from '../src/platform/audit/verification-context.js';

const secret='segment-test-key-'.repeat(3);
const segment=Object.freeze({ id: randomUUID(),environment: 'int',deploymentEpoch: randomUUID(),
  legacyEventCount: 124,inventoryDigest: 'a'.repeat(64) });
const event=()=>normalizePlatformAuditEvent({ operatorId: null,roles: [],permissions: [],assuranceLevel: 'unverified',
  targetTenantId: null,action: 'platform.authentication.failed',targetType: 'authentication',targetId: 'platform',
  previousState: null,newState: null,occurredAt: '2026-10-21T12:00:00.000Z',correlationId: randomUUID(),
  outcome: 'failure',metadata: { reasonCode: 'identity_unmapped' },retentionClass: 'security' });

test('segment configuration rejects noncanonical UUIDs before signing or persistence',()=>{
  const canonical={ id: 'abcdefab-1234-4123-8123-abcdefabcdef',environment: 'int',
    deploymentEpoch: 'fedcbafe-1234-4123-8123-fedcbafedcba' };
  assert.deepEqual(normalizeAuditSegment(canonical),canonical);
  const expected={ environment: 'int',segmentId: canonical.id,deploymentEpoch: canonical.deploymentEpoch,
    legacyEventCount: 124,inventoryDigest: segment.inventoryDigest };
  assert.throws(()=>normalizePlatformAuditSegmentRequest({ ...expected,approvalReference: 'INT-APPROVED',
    correlationId: canonical.id.toUpperCase() },expected),/REQUEST_INVALID/);
  for (const key of ['id','deploymentEpoch']) {
    const invalid={ ...canonical,[key]: canonical[key].toUpperCase() };
    assert.throws(()=>normalizeAuditSegment(invalid),/SEGMENT_INVALID/);
    assert.throws(()=>createSegmentSigners(secret,{ ...segment,...invalid }),/SEGMENT_INVALID/);
    const expected={ environment: 'int',segmentId: invalid.id,deploymentEpoch: invalid.deploymentEpoch,
      legacyEventCount: 124,inventoryDigest: segment.inventoryDigest };
    assert.throws(()=>normalizePlatformAuditSegmentRequest({ ...expected,approvalReference: 'INT-APPROVED',
      correlationId: canonical.id },expected),/REQUEST_INVALID/);
  }
});

function row(value,count,previous=null) {
  return { sequence: segment.legacyEventCount+count,segment_id: segment.id,segment_sequence: count,integrity_version: 2,
    operator_id: value.operatorId,roles: value.roles,permissions: value.permissions,assurance_level: value.assuranceLevel,
    target_tenant_id: value.targetTenantId,action: value.action,target_type: value.targetType,target_id: value.targetId,
    previous_state: value.previousState,new_state: value.newState,occurred_at: value.occurredAt,
    correlation_id: value.correlationId,outcome: value.outcome,metadata: value.metadata,retention_class: value.retentionClass,
    previous_hash: previous,event_hash: createSegmentSigners(secret,segment).event(value,segment.legacyEventCount+count,previous) };
}

test('v2 starts at global 125 without claiming that the old 124 signatures verify',()=>{
  const stored=row(event(),1),verify=createSegmentRowVerifier({ hmacSecret: secret,segment });
  assert.equal(stored.sequence,125);assert.equal(verify([stored]),true);
  assert.equal(createPlatformAuditRowVerifier({ hmacSecret: secret })([stored]),false);
  assert.equal(createSegmentRowVerifier({ hmacSecret: 'other-key-'.repeat(5),segment })([stored]),false);
  for (const mutation of [{ id: randomUUID() },{ deploymentEpoch: randomUUID() },{ inventoryDigest: 'b'.repeat(64) },
    { legacyEventCount: 123 }]) {
    assert.equal(createSegmentRowVerifier({ hmacSecret: secret,segment: { ...segment,...mutation } })([stored]),false);
  }
});

test('v2 refuses event tampering, missing local sequence, discontinuity and foreign segment',()=>{
  const stored=row(event(),1),verify=createSegmentRowVerifier({ hmacSecret: secret,segment });
  for (const mutation of [{ metadata: { reasonCode: 'changed' } },{ segment_sequence: null },{ segment_sequence: 2 },
    { sequence: 126 },{ segment_id: randomUUID() },{ previous_hash: 'b'.repeat(64) },{ integrity_version: 1 }]) {
    assert.equal(verify([{ ...stored,...mutation }]),false);
  }
  const next=row(event(),2,stored.event_hash);
  assert.equal(verify([stored,next]),true);assert.equal(verify([next,stored]),false);
});

test('checkpoint alignment is segment local: first checkpoint is global 156, next event 157',()=>{
  const rows=[];
  for (let count=1;count<=33;count++) rows.push(row(event(),count,rows.at(-1)?.event_hash ?? null));
  const value={ eventCount: 32,terminalEventHash: rows[31].event_hash,previousCheckpointHash: null,
    createdAt: rows[31].occurred_at };
  const checkpoint={ segment_id: segment.id,event_count: 32,terminal_sequence: 156,integrity_version: 2,
    terminal_event_hash: value.terminalEventHash,previous_checkpoint_hash: null,created_at: value.createdAt,
    checkpoint_hash: createSegmentSigners(secret,segment).checkpoint(value) };
  const verify=createSegmentRowVerifier({ hmacSecret: secret,segment });
  assert.equal(verify(rows.slice(0,32)),true);assert.equal(verify([rows[32]],checkpoint),true);
  for (const mutation of [{ terminal_sequence: 32 },{ event_count: 124 },{ segment_id: randomUUID() },
    { checkpoint_hash: 'c'.repeat(64) },{ integrity_version: 1 }]) {
    assert.equal(verify([rows[32]],{ ...checkpoint,...mutation }),false);
  }
});

test('offline request is exact, bounded, deployment-bound and never executes an accessor',()=>{
  const expected={ environment: 'int',segmentId: segment.id,deploymentEpoch: segment.deploymentEpoch,
    legacyEventCount: 124,inventoryDigest: segment.inventoryDigest };
  const request={ ...expected,approvalReference: 'INT-APPROVED',correlationId: randomUUID() };
  assert.deepEqual(normalizePlatformAuditSegmentRequest(request,expected),request);
  for (const mutation of [{ environment: 'prod' },{ legacyEventCount: 125 },{ deploymentEpoch: randomUUID() },
    { inventoryDigest: 'b'.repeat(64) },{ approvalReference: 'no whitespace' },{ approvalReference: 123 },{ extra: true }]) {
    assert.throws(()=>normalizePlatformAuditSegmentRequest({ ...request,...mutation },expected));
  }
  let accessed=false;
  const accessor={ ...request };
  Object.defineProperty(accessor,'segmentId',{ enumerable: true,get() { accessed=true;throw new Error('private'); } });
  assert.throws(()=>normalizePlatformAuditSegmentRequest(accessor,expected));assert.equal(accessed,false);
  assert.throws(()=>normalizePlatformAuditSegmentRequest({ ...request,legacyEventCount: 3201 },
    { ...expected,legacyEventCount: 3201 }));
  const coerced={ toString() { throw new Error('COERCION_MUST_NOT_RUN'); } };
  assert.throws(()=>normalizePlatformAuditSegmentRequest({ ...request,inventoryDigest: coerced },
    { ...expected,inventoryDigest: coerced }),{ message: 'PLATFORM_AUDIT_SEGMENT_REQUEST_INVALID' });
  assert.throws(()=>createSegmentSigners(secret,{ ...segment,inventoryDigest: coerced }),/INTEGRITY/);
  assert.throws(()=>normalizeAuditSegment({ id: segment.id,environment: 'int',deploymentEpoch: segment.deploymentEpoch,extra: true }));
});

test('audit-only genesis cannot carry a principal, permission or legacy verification claim',()=>{
  const genesis={ ...event(),action: 'platform.operator.changed',assuranceLevel: 'offline_owner',
    targetType: 'platform_audit_segment',targetId: segment.id,outcome: 'success',retentionClass: 'recovery',
    metadata: { operation: 'audit_segment_genesis',environment: 'int',deploymentEpoch: segment.deploymentEpoch,
      inventoryDigest: segment.inventoryDigest,approvalReference: 'INT-APPROVED',legacyVerification: 'unavailable' } };
  assert.equal(normalizePlatformAuditEvent(genesis).operatorId,null);
  assert.throws(()=>normalizePlatformAuditEvent({ ...genesis,roles: ['platform_security_admin'] }));
  assert.throws(()=>normalizePlatformAuditEvent({ ...genesis,metadata: { ...genesis.metadata,legacyVerification: 'verified' } }));
});

test('export context retains explicit unavailable legacy status and rejects an invented verified prefix',()=>{
  const context={ segmentId: segment.id,verification: 'verified',legacy: { eventCount: 124,verification: 'unavailable' } };
  assert.deepEqual(projectPlatformAuditVerification(context),context);
  for (const mutation of [{ verification: 'unavailable' },{ extra: true },
    { legacy: { eventCount: 124,verification: 'verified' } },{ legacy: { eventCount: -1,verification: 'unavailable' } }]) {
    assert.throws(()=>projectPlatformAuditVerification({ ...context,...mutation }));
  }
});
