import { createHash } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { CalendarProviderError,PROVIDER_ERROR_KIND } from '../../integrations/calendar-contract.js';
import { SyntheticCalendarValueError,normalizeSyntheticCalendarBinding,normalizeSyntheticCalendarSelection,
  normalizeSyntheticCalendarCommand,
  syntheticCalendarMetadata } from '../../domain/synthetic-calendar.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from './transaction.js';

function fail(kind) { throw new CalendarProviderError(kind,{ operation: 'synthetic_calendar' }); }
function mapped(error) {
  if (error instanceof CalendarProviderError) return error;
  if (error instanceof SyntheticCalendarValueError) {
    return new CalendarProviderError(error.kind,{ operation: 'synthetic_calendar' });
  }
  const kinds={ '23P01': 'CONFLICT','23505': 'DUPLICATE','23503': 'AUTHORIZATION','23514': 'AUTHORIZATION',
    '42501': 'AUTHORIZATION','40001': 'UNAVAILABLE','40P01': 'UNAVAILABLE','57014': 'TIMEOUT' };
  return new CalendarProviderError(PROVIDER_ERROR_KIND[kinds[error?.code] ?? 'UNKNOWN'],{ operation: 'synthetic_calendar' });
}
function eventId(binding,key) {
  const bytes=createHash('sha256').update(`synthetic-calendar:v1:${binding.tenantId}:${binding.integrationId}:${key}`).digest();
  // Namespaced deterministic UUIDv8: concurrent same-key retries address the
  // same event before the unique constraint, including a first-insert race.
  bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const hex=bytes.subarray(0,16).toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}
function sameEvent(row,command) {
  if (!row || row.request_id!==command.requestId || row.state!=='active'
    || !(row.starts_at instanceof Date) || !(row.ends_at instanceof Date)
    || row.starts_at.toISOString()!==command.startsAt || row.ends_at.toISOString()!==command.endsAt) fail(PROVIDER_ERROR_KIND.DUPLICATE);
}
export function createPostgresSyntheticCalendarRepository(pool,{ environment,securityEpoch }={}) {
  if (!pool || typeof pool.query!=='function' || typeof pool.connect!=='function'
    || !['dev','int'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('SYNTHETIC_CALENDAR_STORE_CONFIGURATION_INVALID');
  }
  const scope=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  async function transaction(work,readOnly=false) {
    requireProtectedRuntimeSharedExecutionScope(pool,scope);
    try { return await withPostgresTransaction(pool,work,{ readOnly }); } catch (error) { throw mapped(error); }
  }
  async function current(client,selection) {
    const result=await client.query({ name: 'synthetic-calendar-current-resource',text: `SELECT resource.tenant_id,
      resource.room_id,resource.integration_id,resource.generation_id FROM synthetic_calendar_resources resource
      JOIN tenant_runtime_registry registry ON registry.environment=resource.environment AND registry.tenant_id=resource.tenant_id
        AND registry.mode='synthetic' AND registry.generation_id=resource.generation_id
      JOIN synthetic_tenant_generations generation ON generation.environment=registry.environment
        AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id
        AND generation.state='active' AND generation.security_epoch=resource.security_epoch
      JOIN protected_runtime_deployments deployment ON deployment.environment=resource.environment
        AND deployment.security_epoch=resource.security_epoch
      JOIN platform_operators actor ON actor.id=registry.operator_id AND actor.status='active'
        AND actor.provider='microsoft_entra_platform' AND actor.security_version=generation.operator_security_version
      JOIN tenants tenant ON tenant.id=resource.tenant_id AND tenant.status='active'
      JOIN rooms room ON room.tenant_id=resource.tenant_id AND room.id=resource.room_id AND room.active=true
      JOIN integrations integration ON integration.tenant_id=resource.tenant_id AND integration.id=resource.integration_id
        AND integration.provider='synthetic_calendar' AND integration.status='active'
        AND integration.provider_reference='synthetic:' || resource.generation_id::text
      WHERE resource.environment=$1 AND resource.security_epoch=$2 AND resource.tenant_id=$3 AND resource.room_id=$4`,
    values: [environment,scope.securityEpoch,selection.tenantId,selection.roomId] });
    if (result.rowCount!==1) return null;
    const row=result.rows[0];return normalizeSyntheticCalendarBinding({ tenantId: row.tenant_id,roomId: row.room_id,
      integrationId: row.integration_id,generationId: row.generation_id });
  }
  async function qualified(client,binding) {
    const found=await current(client,binding);
    if (!found || found.integrationId!==binding.integrationId || found.generationId!==binding.generationId) {
      fail(PROVIDER_ERROR_KIND.AUTHORIZATION);
    }
  }
  const values=binding=>[environment,scope.securityEpoch,binding.tenantId,binding.generationId,binding.integrationId,binding.roomId];
  async function existing(client,binding,id) {
    const result=await client.query({ name: 'synthetic-calendar-owned-event',text: `SELECT id,request_id,idempotency_key,
      starts_at,ends_at,state,revision FROM synthetic_calendar_events WHERE environment=$1 AND security_epoch=$2
      AND tenant_id=$3 AND generation_id=$4 AND integration_id=$5 AND room_id=$6 AND id=$7 FOR UPDATE`,
    values: [...values(binding),id] });
    return result.rows[0] ?? null;
  }
  function command(binding,value,operation) {
    try {
      binding=normalizeSyntheticCalendarBinding(binding);
      return { binding,input: normalizeSyntheticCalendarCommand(binding,value,operation) };
    } catch (error) { throw mapped(error); }
  }
  return Object.freeze({
    findBinding(value) {
      let selection;try { selection=normalizeSyntheticCalendarSelection(value); } catch (error) { throw mapped(error); }
      return transaction(client=>current(client,selection),true);
    },
    lookupAvailability(binding,value) {
      const { binding: bound,input }=command(binding,value,'availability');
      return transaction(async client=>{
        await qualified(client,bound);
        const result=await client.query({ name: 'synthetic-calendar-overlap',text: `SELECT EXISTS(SELECT 1
          FROM synthetic_calendar_events WHERE environment=$1 AND security_epoch=$2 AND tenant_id=$3 AND generation_id=$4
          AND integration_id=$5 AND room_id=$6 AND state='active' AND request_id<>$7 AND starts_at<$9 AND ends_at>$8) AS conflict`,
        values: [...values(bound),input.requestId,input.startsAt,input.endsAt] });
        if (typeof result.rows[0]?.conflict!=='boolean') fail(PROVIDER_ERROR_KIND.MALFORMED_RESPONSE);
        return Object.freeze({ available: !result.rows[0].conflict,conflictCount: result.rows[0].conflict ? 1 : 0 });
      },true);
    },
    createEvent(binding,value) {
      const { binding: bound,input }=command(binding,value,'create'),id=eventId(bound,input.idempotencyKey);
      return transaction(async client=>{
        await qualified(client,bound);let row=await existing(client,bound,id),created=false;
        if (!row) {
          const inserted=await client.query({ name: 'synthetic-calendar-event-create',text: `INSERT INTO synthetic_calendar_events
            (environment,security_epoch,tenant_id,generation_id,integration_id,room_id,id,request_id,
              idempotency_key,starts_at,ends_at,state)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active') ON CONFLICT(tenant_id,id) DO NOTHING RETURNING id`,
          values: [...values(bound),id,input.requestId,input.idempotencyKey,input.startsAt,input.endsAt] });
          created=inserted.rowCount===1;row=await existing(client,bound,id);
        }
        sameEvent(row,input);if (row.idempotency_key!==input.idempotencyKey) fail(PROVIDER_ERROR_KIND.DUPLICATE);
        return Object.freeze({ providerReference: `synthetic-event:${id}`,
          providerResourceReference: syntheticCalendarMetadata(bound).providerResourceReference,
          disposition: created ? 'created' : 'existing' });
      });
    },
    updateEvent(binding,value) {
      const { binding: bound,input }=command(binding,value,'update');
      return transaction(async client=>{
        await qualified(client,bound);const row=await existing(client,bound,input.eventId);
        if (!row || row.request_id!==input.requestId || row.state!=='active') fail(PROVIDER_ERROR_KIND.NOT_FOUND);
        const unchanged=row.starts_at.toISOString()===input.startsAt && row.ends_at.toISOString()===input.endsAt;
        if (!unchanged) await client.query({ name: 'synthetic-calendar-event-update',text: `UPDATE synthetic_calendar_events
          SET starts_at=$8,ends_at=$9,revision=revision+1,updated_at=clock_timestamp()
          WHERE environment=$1 AND security_epoch=$2 AND tenant_id=$3 AND generation_id=$4 AND integration_id=$5 AND room_id=$6 AND id=$7`,
        values: [...values(bound),input.eventId,input.startsAt,input.endsAt] });
        return Object.freeze({ providerReference: `synthetic-event:${input.eventId}`,disposition: unchanged ? 'unchanged' : 'updated' });
      });
    },
    cancelEvent(binding,value) {
      const { binding: bound,input }=command(binding,value,'cancel');
      return transaction(async client=>{
        await qualified(client,bound);const row=await existing(client,bound,input.eventId);
        if (!row || row.request_id!==input.requestId) fail(PROVIDER_ERROR_KIND.NOT_FOUND);
        const cancelled=row.state==='cancelled';
        if (!cancelled) await client.query({ name: 'synthetic-calendar-event-cancel',text: `UPDATE synthetic_calendar_events
          SET state='cancelled',revision=revision+1,updated_at=clock_timestamp()
          WHERE environment=$1 AND security_epoch=$2 AND tenant_id=$3 AND generation_id=$4 AND integration_id=$5 AND room_id=$6 AND id=$7`,
        values: [...values(bound),input.eventId] });
        return Object.freeze({ providerReference: `synthetic-event:${input.eventId}`,
          disposition: cancelled ? 'already_cancelled' : 'cancelled' });
      });
    },
  });
}
