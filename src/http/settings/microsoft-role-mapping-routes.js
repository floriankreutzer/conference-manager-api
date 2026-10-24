import { ApiError } from '../../api-error.js';
import { readJsonObjectBody,validateExactObject } from '../../security.js';
import { MicrosoftRoleMappingConflictError } from '../../application/tenant-microsoft-role-service.js';
import { normalizeMicrosoftDirectoryId,normalizeMicrosoftGroupMappings } from '../../authorization/microsoft-group-mapping.js';
import { defineRouteModule } from '../route-module.js';

const PATH='/api/v1/tenant/microsoft-role-mappings';
function publicSettings(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision<0 || value.revision>=2147483647) {
    throw new ApiError(500,'MICROSOFT_ROLE_MAPPING_RESULT_INVALID');
  }
  const mappings=normalizeMicrosoftGroupMappings(value.mappings);
  if (value.revision===0 && (value.directoryId!==null || mappings.length)) throw new ApiError(500,'MICROSOFT_ROLE_MAPPING_RESULT_INVALID');
  return { revision: value.revision,directoryId: value.revision===0 ? null : normalizeMicrosoftDirectoryId(value.directoryId),mappings };
}
export function createMicrosoftRoleMappingRouteModule({ service,publicOrigin }={}) {
  if (['get','replace'].some(name=>typeof service?.[name]!=='function') || typeof publicOrigin!=='string') {
    throw new TypeError('MICROSOFT_ROLE_HTTP_CONFIGURATION_INVALID');
  }
  return defineRouteModule({ id: 'microsoft-role-mappings',routeKey: path=>path===PATH ? 'microsoft_role_mappings' : null,
    createHandler({ principalGuard,tenantGuard,maxBodyBytes,maxResponseBytes }={}) {
      if (typeof principalGuard?.require!=='function' || typeof tenantGuard?.requireKnown!=='function'
        || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes<1024
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
        throw new TypeError('MICROSOFT_ROLE_HTTP_CONFIGURATION_INVALID');
      }
      return async({ request,response,path,parsedUrl,requestId })=>{
        if (path!==PATH) return null;
        if (!['GET','PUT'].includes(request.method)) throw new ApiError(405,'METHOD_NOT_ALLOWED');
        const write=request.method==='PUT';
        if (parsedUrl.search || parsedUrl.hash) throw new ApiError(400,'VALIDATION_FAILED');
        if (request.headers['sec-fetch-site']!==undefined && request.headers['sec-fetch-site']!=='same-origin'
          || write && request.headers.origin!==publicOrigin) throw new ApiError(403,'ORIGIN_NOT_ALLOWED');
        const principal=await principalGuard.require(request,{ csrf: write });
        const tenantContext=await tenantGuard.requireKnown(principal),context={ principal,tenantContext,correlationId: requestId };
        let settings;
        try {
          if (write) {
            const body=validateExactObject(await readJsonObjectBody(request,{ maxBytes: Math.min(maxBodyBytes,32768) }),{
              required: { directoryId: value=>typeof value==='string',mappings: Array.isArray,
                expectedRevision: value=>Number.isSafeInteger(value) && value>=0 && value<2147483646 },optional: {},
            });
            settings=await service.replace(context,body);
          } else {
            if (request.headers['transfer-encoding']!==undefined
              || request.headers['content-length']!==undefined && request.headers['content-length']!=='0') {
              throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
            }
            for await (const chunk of request) if (chunk.length) throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
            settings=await service.get(context);
          }
        } catch (error) {
          if (error instanceof MicrosoftRoleMappingConflictError) {
            throw new ApiError(409,error.code,{ currentRevision: error.currentRevision });
          }
          throw error;
        }
        const body=JSON.stringify({ settings: publicSettings(settings),requestId });
        if (Buffer.byteLength(body)>maxResponseBytes) throw new ApiError(500,'RESPONSE_TOO_LARGE');
        response.statusCode=200;response.setHeader('Content-Type','application/json; charset=utf-8');
        response.setHeader('Content-Length',Buffer.byteLength(body));response.end(body);return 200;
      };
    },
  });
}
