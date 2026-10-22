import { normalizePlatformAuditEvent } from '../../platform/audit/event.js';
import { PlatformAuditIntegrityError, PlatformAuditInputError } from '../../platform/audit/errors.js';
import { withPostgresTransaction } from './transaction.js';
import { normalizeAuditSegment,createSegmentSigners,createSegmentRowVerifier,instant,mapEventRow,projectEvent,
  PLATFORM_AUDIT_EVENT_COLUMNS } from './platform-audit-integrity.js';

const COLUMNS = `${PLATFORM_AUDIT_EVENT_COLUMNS},segment_id,segment_sequence`;
const refuse = () => { throw new PlatformAuditIntegrityError(); };

export function createPostgresPlatformAuditSegmentRepository(pool,{ hmacSecret,segment: expected,readPage }) {
  expected = normalizeAuditSegment(expected);

  async function context(client,lock = false) {
    const rows = await client.query(`SELECT s.*,h.event_count,h.terminal_event_hash,h.terminal_checkpoint_hash
      FROM platform_audit_segments s JOIN platform_audit_segment_heads h ON h.segment_id=s.id
      WHERE s.id=$1 AND s.environment=$2 AND s.deployment_epoch=$3
        AND EXISTS(SELECT 1 FROM protected_runtime_deployments d
          WHERE d.environment=s.environment AND d.security_epoch=s.deployment_epoch)
      ${lock ? 'FOR UPDATE OF h' : ''}`,[expected.id,expected.environment,expected.deploymentEpoch]);
    if (rows.rowCount !== 1) refuse();
    const row = rows.rows[0];
    const segment = Object.freeze({ ...expected,legacyEventCount: Number(row.legacy_event_count),
      inventoryDigest: row.inventory_digest,approvalReference: row.approval_reference });
    const count = Number(row.event_count);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(segment.legacyEventCount + count)) refuse();
    return { segment,count,row,sign: createSegmentSigners(hmacSecret,segment),
      verify: createSegmentRowVerifier({ hmacSecret,segment }) };
  }

  async function verifyRange(client,state,anchor,maximum) {
    const checkpoint = anchor === 0 ? null : (await client.query(`SELECT * FROM platform_audit_segment_checkpoints
      WHERE segment_id=$1 AND event_count=$2`,[expected.id,anchor])).rows[0];
    if (anchor > 0 && !checkpoint) refuse();
    const rows = await client.query(`SELECT ${COLUMNS} FROM platform_audit_events
      WHERE segment_id=$1 AND segment_sequence>$2 AND segment_sequence<=$3 ORDER BY segment_sequence`,
    [expected.id,anchor,maximum]);
    if (rows.rowCount !== maximum-anchor || !state.verify(rows.rows,checkpoint)) refuse();
    return rows.rows.at(-1) ?? null;
  }

  async function verifyState(client,state) {
    if (state.count < 1) refuse();
    const genesis = await verifyRange(client,state,0,1);
    if (genesis.target_type !== 'platform_audit_segment' || genesis.target_id !== expected.id
      || genesis.metadata?.operation !== 'audit_segment_genesis'
      || genesis.metadata?.inventoryDigest !== state.segment.inventoryDigest
      || genesis.metadata?.legacyVerification !== 'unavailable') refuse();
    const anchor = Math.floor((state.count-1)/32)*32;
    const terminal = await verifyRange(client,state,anchor,state.count);
    if (terminal.event_hash !== state.row.terminal_event_hash) refuse();
    const checkpoint = Math.floor(state.count/32)*32;
    if (checkpoint === 0) {
      if (state.row.terminal_checkpoint_hash !== null) refuse();
    } else {
      const row = (await client.query(`SELECT * FROM platform_audit_segment_checkpoints
        WHERE segment_id=$1 AND event_count=$2`,[expected.id,checkpoint])).rows[0];
      if (!row || row.checkpoint_hash !== state.row.terminal_checkpoint_hash || !state.verify([],row)) refuse();
    }
  }

  async function appendWithClient(client,value,{ expectedTargetTenantId } = {}) {
    let event = normalizePlatformAuditEvent(value);
    if (event.targetTenantId !== null && expectedTargetTenantId !== event.targetTenantId
      || event.targetTenantId === null && expectedTargetTenantId !== undefined && expectedTargetTenantId !== null) {
      throw new PlatformAuditInputError('PLATFORM_AUDIT_AUTHORITATIVE_TARGET_REQUIRED');
    }
    await client.query('LOCK TABLE platform_audit_segments IN ACCESS SHARE MODE');
    const state = await context(client,true);
    if (state.count > 0) await verifyState(client,state);
    else if (event.targetType !== 'platform_audit_segment') refuse();
    const clock = await client.query('SELECT clock_timestamp() AS occurred_at');
    event = normalizePlatformAuditEvent({ ...event,occurredAt: instant(clock.rows[0].occurred_at) });
    const count = state.count+1,sequence = state.segment.legacyEventCount+count;
    const hash = state.sign.event(event,sequence,state.row.terminal_event_hash);
    const inserted = await client.query(`INSERT INTO platform_audit_events
      (sequence,operator_id,roles,permissions,assurance_level,target_tenant_id,action,target_type,target_id,
        previous_state,new_state,occurred_at,correlation_id,outcome,metadata,retention_class,previous_hash,event_hash,
        integrity_version,segment_id,segment_sequence)
      VALUES($1,$2,$3::text[],$4::text[],$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15::jsonb,$16,$17,$18,2,$19,$20)
      RETURNING ${COLUMNS}`,[sequence,event.operatorId,event.roles,event.permissions,event.assuranceLevel,event.targetTenantId,
      event.action,event.targetType,event.targetId,event.previousState===null ? null : JSON.stringify(event.previousState),
      event.newState===null ? null : JSON.stringify(event.newState),event.occurredAt,event.correlationId,event.outcome,
      JSON.stringify(event.metadata),event.retentionClass,state.row.terminal_event_hash,hash,expected.id,count]);
    let checkpointHash = state.row.terminal_checkpoint_hash;
    if (count%32 === 0) {
      checkpointHash = state.sign.checkpoint({ eventCount: count,terminalEventHash: hash,
        previousCheckpointHash: checkpointHash,createdAt: event.occurredAt });
      await client.query(`INSERT INTO platform_audit_segment_checkpoints
        (segment_id,event_count,terminal_sequence,terminal_event_hash,previous_checkpoint_hash,checkpoint_hash,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[expected.id,count,sequence,hash,state.row.terminal_checkpoint_hash,
        checkpointHash,event.occurredAt]);
    }
    await client.query(`UPDATE platform_audit_segment_heads SET event_count=$2,terminal_event_hash=$3,
      terminal_checkpoint_hash=$4 WHERE segment_id=$1`,[expected.id,count,hash,checkpointHash]);
    return mapEventRow(inserted.rows[0]);
  }

  return Object.freeze({
    appendWithClient,
    append(value,options) { return withPostgresTransaction(pool,client=>appendWithClient(client,value,options)); },
    async verifyWithClient(client) { const state=await context(client);await verifyState(client,state);return true; },
    async isReady() {
      try {
        await withPostgresTransaction(pool,async client=>{
          const state=await context(client,true);await verifyState(client,state);
        });
        return true;
      } catch { return false; }
    },
    async verificationContext() {
      return withPostgresTransaction(pool,async client=>{
        const state=await context(client,true);await verifyState(client,state);
        return Object.freeze({ segmentId: expected.id,verification: 'verified',legacy: Object.freeze({
          eventCount: state.segment.legacyEventCount,verification: 'unavailable' }) });
      });
    },
    async listVerified({ limit=50,beforeSequence=null,scope,from=null,to=null }={}) {
      return withPostgresTransaction(pool,async client=>{
      const state=await context(client,true);await verifyState(client,state);
      const page=await readPage({ limit,beforeSequence,scope,from,to },client);
      const buckets=new Map();
      for (const row of page.rows) {
        const count=Number(row.sequence)-state.segment.legacyEventCount;
        if (!Number.isSafeInteger(count) || count<1 || count>state.count) refuse();
        const anchor=Math.floor((count-1)/32)*32;
        buckets.set(anchor,Math.max(buckets.get(anchor) ?? 0,count));
      }
      for (const [anchor,maximum] of buckets) await verifyRange(client,state,anchor,maximum);
      return Object.freeze(page.rows.map(row=>projectEvent(mapEventRow(row))));
      });
    },
  });
}
