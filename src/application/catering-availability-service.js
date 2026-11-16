import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isRequestId,isRequestVersion } from '../domain/request.js';
import { CATERING_MAX_ORDER_POSITIONS } from '../domain/catering-order-limits.js';
import { CATERING_MAX_AVAILABILITY_AGE_MS,normalizeCateringAvailabilityQuery,normalizeCateringAvailabilityObservation,
  normalizeCateringAvailabilityRequestCommand,normalizeCateringAvailabilityManualReceiptCommand } from '../domain/catering-availability.js';
import { normalizeCateringConfiguration } from '../integrations/catering-configuration.js';
import { isTenantBusinessActive } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { CateringAvailabilityInputError,CateringAvailabilityConflictError } from './catering-availability-errors.js';

function invalid() { throw new TypeError('CATERING_AVAILABILITY_RESULT_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function requestId(value) { if (!isRequestId(value)) invalid(); return value; }
function requestVersion(value) { if (!isRequestVersion(value)) invalid(); return value; }
function counter(value,minimum=1,maximum=Number.MAX_SAFE_INTEGER-1) {
  if (!Number.isSafeInteger(value) || value<minimum || value>maximum) invalid(); return value;
}
function age(value) { return counter(value,1,CATERING_MAX_AVAILABILITY_AGE_MS); }
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value;
}
function record(value,keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own=Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(name=>{
    const property=Object.getOwnPropertyDescriptor(value,name);
    return !keys.includes(name) || !property.enumerable || !Object.hasOwn(property,'value');
  })) invalid();
}
function array(value,maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length>maximum
    || Reflect.ownKeys(value).length !== value.length+1) invalid();
  for (let i=0;i<value.length;i++) {
    const property=Object.getOwnPropertyDescriptor(value,String(i));
    if (!property?.enumerable || !Object.hasOwn(property,'value')) invalid();
  }
  return value;
}
function input(work) { try { return work(); } catch { throw new CateringAvailabilityInputError(); } }
function equal(a,b) { return JSON.stringify(a) === JSON.stringify(b); }

// Transactional port orchestration only. No provider, credential, scheduler,
// publication, quote or delivery port exists in this use case.
export function createCateringAvailabilityService({repository,registry,authorizationPolicy,auditService,maximumAgeMs=300000}={}) {
  if (!['request','receive'].every(name=>typeof repository?.[name] === 'function') || typeof registry?.get !== 'function'
    || !['requestListScope','requireTenantPermission'].every(name=>typeof authorizationPolicy?.[name] === 'function')
    || !['createEvent','recordAuthorizationDenied'].every(name=>typeof auditService?.[name] === 'function')) {
    throw new TypeError('CATERING_AVAILABILITY_PORT_REQUIRED');
  }
  age(maximumAgeMs);
  async function denied(authority,operation) {
    if (isInternalUuid(authority?.principal?.tenantId) && authority.principal.tenantId === authority?.tenantContext?.tenantId) {
      await auditService.recordAuthorizationDenied({...authority,targetType:'request',
        targetId:'catering-availability',metadata:{operation}});
    }
  }
  async function authorize(context,manager) {
    uuid(context?.correlationId); let selection;
    try {
      if (manager) authorizationPolicy.requireTenantPermission(context?.principal,context?.tenantContext,PERMISSION.REQUEST_MANAGE);
      else selection=authorizationPolicy.requestListScope(context?.principal,context?.tenantContext);
    } catch (error) { if (error instanceof AuthorizationDeniedError) await denied(context,'catering_availability'); throw error; }
    if (!isTenantBusinessActive(context.tenantContext)) throw new TenantUnavailableError();
    const tenantId=uuid(context.tenantContext.tenantId); const actorUserId=uuid(context.principal.userId);
    const session=context.principal.session;
    if (!isInternalUuid(session?.id) || !Number.isSafeInteger(session.securityVersion) || session.securityVersion<1
      || session.securityVersion>=Number.MAX_SAFE_INTEGER) throw new AuthorizationDeniedError('SESSION_REQUIRED');
    const requesterUserId=manager || selection?.requesterUserId === null ? null : uuid(selection?.requesterUserId);
    if (requesterUserId !== null && requesterUserId !== actorUserId) invalid();
    const authority={principal:{...context.principal,tenantId,userId:actorUserId},
      tenantContext:{...context.tenantContext,tenantId},correlationId:uuid(context.correlationId)};
    return {authority,tenantId,actorUserId,requesterUserId,sessionId:uuid(session.id),expectedSecurityVersion:session.securityVersion};
  }
  function configured(state,manual=false) {
    if (typeof state.connectionAvailable !== 'boolean') invalid();
    let configuration;
    try { configuration=normalizeCateringConfiguration(state.configuration,registry.get(state.providerId)); } catch { invalid(); }
    const mode=configuration.capabilities['catering.availability'];
    if (!state.connectionAvailable || configuration.capabilities['catering.catalogue'] === 'unsupported'
      || (manual ? mode !== 'manual' : !['manual','api'].includes(mode))) {
      throw new CateringAvailabilityConflictError('SOURCE_UNAVAILABLE');
    }
  }
  async function result(value,success,authority) {
    const status=value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value,'status') : null;
    if (!status?.enumerable || !Object.hasOwn(status,'value')) invalid();
    record(value,status.value === success ? ['status','replayed','receipt']
      : status.value === 'conflict' ? ['status','kind'] : ['status']);
    if (status.value === 'not_authorized') {
      await denied(authority,'catering_availability'); throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
    }
    if (status.value === 'not_found') throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE',{conceal:true});
    if (status.value === 'conflict') throw new CateringAvailabilityConflictError(value.kind);
    if (status.value !== success || typeof value.replayed !== 'boolean') invalid(); return value;
  }
  return Object.freeze({
    async request(context) {
      const authorized=await authorize(context,false); const target=input(()=>requestId(context.requestId));
      const command=input(()=>normalizeCateringAvailabilityRequestCommand(context.command));
      const generated=new Map(); let admission=null;
      const saved=await result(await repository.request({...authorized,requestId:target,command,maximumAgeMs,
        queryFor(state) {
          record(state,['tenantId','integrationId','requestId','requestVersion',
            'providerId','configuration','connectionAvailable','query']);
          if (state.tenantId !== authorized.tenantId || state.requestId !== target
            || state.requestVersion !== command.expectedRequestVersion) invalid(); configured(state);
          const value=normalizeCateringAvailabilityQuery(state.query,{tenantId:authorized.tenantId,integrationId:uuid(state.integrationId),
            requestId:target,requestVersion:command.expectedRequestVersion});
          if (generated.has(value.queryId) || generated.size>=CATERING_MAX_ORDER_POSITIONS) invalid(); generated.set(value.queryId,value);
          return value;
        },
        auditEventFor(value) {
          record(value,['availabilityRevision','roundRevision','recordedAt']);
          if (admission !== null || value.availabilityRevision !== command.expectedRevision+1
            || counter(value.roundRevision)>value.availabilityRevision) invalid(); admission={...value};
          return auditService.createEvent({...authorized.authority,action:'catering.availability.requested',
            targetType:'request',targetId:target,
            outcome:'success',retentionClass:'business',previousState:{revision:command.expectedRevision},
            newState:{revision:value.availabilityRevision},
            occurredAt:instant(value.recordedAt),
            metadata:{operation:'catering_availability_request'}});
        }}),'requested',authorized.authority);
      const receipt=saved.receipt;
      record(receipt,['tenantId','requestId','requestVersion','actorUserId','actorSecurityVersion','command',
        'availabilityRevision','roundRevision','queries','recordedAt']);
      if (receipt.tenantId !== authorized.tenantId || receipt.requestId !== target
        || receipt.requestVersion !== command.expectedRequestVersion || receipt.actorUserId !== authorized.actorUserId
        || receipt.actorSecurityVersion !== authorized.expectedSecurityVersion
        || !equal(normalizeCateringAvailabilityRequestCommand(receipt.command),command)
        || receipt.availabilityRevision !== command.expectedRevision+1
        || counter(receipt.roundRevision)>receipt.availabilityRevision) invalid();
      const queries=array(receipt.queries,CATERING_MAX_ORDER_POSITIONS); if (!queries.length) invalid();
      const integrations=new Set(); const queryIds=new Set(); const positions=new Set(); let positionCount=0;
      for (const source of queries) {
        record(source,['integrationId','query','maximumAgeMs']); const integrationId=uuid(source.integrationId);
        const value=normalizeCateringAvailabilityQuery(source.query,{tenantId:authorized.tenantId,integrationId,
          requestId:target,requestVersion:command.expectedRequestVersion});
        if (integrations.has(integrationId) || queryIds.has(value.queryId) || (!saved.replayed
          && (!equal(generated.get(value.queryId),value) || age(source.maximumAgeMs) !== maximumAgeMs))) invalid();
        age(source.maximumAgeMs); integrations.add(integrationId); queryIds.add(value.queryId); positionCount+=value.positions.length;
        for (const position of value.positions) { if (positions.has(position.positionId)) invalid(); positions.add(position.positionId); }
      }
      if (positionCount>CATERING_MAX_ORDER_POSITIONS || (!saved.replayed && (generated.size !== queries.length || !admission
        || admission.roundRevision !== receipt.roundRevision || admission.recordedAt !== receipt.recordedAt))) invalid();
      return Object.freeze({schemaVersion:1,commandId:command.commandId,replayed:saved.replayed,requestId:target,
        requestVersion:receipt.requestVersion,availabilityRevision:receipt.availabilityRevision,roundRevision:receipt.roundRevision,
        queryCount:queries.length,recordedAt:instant(receipt.recordedAt)});
    },
    async receive(context) {
      const authorized=await authorize(context,true); const queryId=input(()=>uuid(context.queryId));
      const command=input(()=>normalizeCateringAvailabilityManualReceiptCommand(context.command,queryId));
      let admission=null; let planned=null;
      const saved=await result(await repository.receive({...authorized,queryId,command,maximumAgeMs,
        observationFor(state) {
          record(state,['tenantId','integrationId','requestId','requestVersion','providerId','configuration','connectionAvailable',
            'query','receivedAt','maximumAgeMs','currentRequestVersion','configurationRevision','publicationRevision',
            'publishedSourceRevision',
            'roundRevision']);
          if (state.tenantId !== authorized.tenantId) invalid(); configured(state,true);
          const query=normalizeCateringAvailabilityQuery(state.query,{tenantId:authorized.tenantId,integrationId:uuid(state.integrationId),
            requestId:requestId(state.requestId),requestVersion:requestVersion(state.requestVersion)});
          if (query.queryId !== queryId) invalid();
          for (const [kind,current,observed] of [['REQUEST',state.currentRequestVersion,query.requestVersion],
            ['CONFIGURATION',state.configurationRevision,query.configurationRevision],
            ['PUBLICATION',state.publicationRevision,query.publicationRevision],
            ['SOURCE',state.publishedSourceRevision,query.sourceRevision],['ROUND',state.roundRevision,command.expectedRoundRevision]]) {
            if (counter(current) !== observed) throw new CateringAvailabilityConflictError(`${kind}_CONFLICT`);
          }
          const effectiveAge=Math.min(age(state.maximumAgeMs),maximumAgeMs); const receivedAt=instant(state.receivedAt);
          const observation=input(()=>normalizeCateringAvailabilityObservation(command.observation,{tenantId:authorized.tenantId,
            integrationId:query.integrationId,requestId:query.requestId,requestVersion:query.requestVersion,
            query:state.query,receivedAt,maximumAgeMs:effectiveAge}));
          planned={observation,maximumAgeMs:effectiveAge}; return Object.freeze(planned);
        },
        auditEventFor(value) {
          record(value,['requestId','requestVersion','previousRevision','availabilityRevision','roundRevision','recordedAt']);
          if (admission !== null || !planned || value.availabilityRevision !== counter(value.previousRevision)+1
            || value.roundRevision !== command.expectedRoundRevision || value.requestId !== planned.observation.requestId
            || value.requestVersion !== planned.observation.requestVersion
            || value.recordedAt !== planned.observation.receivedAt) invalid();
          admission={...value}; return auditService.createEvent({...authorized.authority,action:'catering.availability.received',
            targetType:'request',targetId:requestId(value.requestId),outcome:'success',retentionClass:'business',
            previousState:{revision:value.previousRevision},newState:{revision:value.availabilityRevision},
            occurredAt:instant(value.recordedAt),
            metadata:{operation:'catering_availability_receive',source:'manual'}});
        }}),'recorded',authorized.authority);
      const receipt=saved.receipt;
      record(receipt,['tenantId','integrationId','queryId','requestId','requestVersion','actorUserId','actorSecurityVersion','command',
        'availabilityRevision','roundRevision','query','queryMaximumAgeMs','maximumAgeMs','observation','recordedAt']);
      if (receipt.tenantId !== authorized.tenantId || uuid(receipt.queryId) !== queryId || receipt.actorUserId !== authorized.actorUserId
        || receipt.actorSecurityVersion !== authorized.expectedSecurityVersion || receipt.roundRevision !== command.expectedRoundRevision
        || counter(receipt.availabilityRevision)<receipt.roundRevision || age(receipt.maximumAgeMs)>age(receipt.queryMaximumAgeMs)
        || !equal(normalizeCateringAvailabilityManualReceiptCommand(receipt.command,queryId),command)) invalid();
      const observation=normalizeCateringAvailabilityObservation(command.observation,{tenantId:authorized.tenantId,
        integrationId:uuid(receipt.integrationId),requestId:requestId(receipt.requestId),
        requestVersion:requestVersion(receipt.requestVersion),
        query:receipt.query,receivedAt:instant(receipt.recordedAt),maximumAgeMs:receipt.maximumAgeMs});
      if (!equal(observation,receipt.observation) || (!saved.replayed && (!admission || !equal(planned?.observation,observation)
        || admission.availabilityRevision !== receipt.availabilityRevision || receipt.maximumAgeMs !== planned.maximumAgeMs))) invalid();
      return Object.freeze({schemaVersion:1,commandId:command.commandId,replayed:saved.replayed,queryId,requestId:receipt.requestId,
        requestVersion:receipt.requestVersion,availabilityRevision:receipt.availabilityRevision,roundRevision:receipt.roundRevision,
        recordedAt:instant(receipt.recordedAt)});
    },
  });
}
