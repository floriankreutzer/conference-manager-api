function capabilityByName(entries, name) {
  const entry = entries.find((candidate) => candidate.capability === name);
  return entry || Object.freeze({
    capability: name,
    status: 'not_configured',
    reason: null,
    lastCheckedAt: null,
    lastSuccessAt: null,
  });
}

function connectionCapability(connection, permission, capability) {
  if (connection.status === 'revoked') {
    return Object.freeze({
      capability,
      status: 'revoked',
      reason: connection.reason || 'provider_authorization_failed',
      lastCheckedAt: connection.lastVerifiedAt,
      lastSuccessAt: null,
    });
  }
  if (permission === 'missing') {
    return Object.freeze({
      capability,
      status: 'permission_missing',
      reason: `${capability}_permission_missing`,
      lastCheckedAt: connection.lastVerifiedAt,
      lastSuccessAt: null,
    });
  }
  if (permission === 'granted') {
    return Object.freeze({
      capability,
      status: 'healthy',
      reason: null,
      lastCheckedAt: connection.lastVerifiedAt,
      lastSuccessAt: connection.lastVerifiedAt,
    });
  }
  return Object.freeze({
    capability,
    status: 'not_configured',
    reason: null,
    lastCheckedAt: connection.lastVerifiedAt,
    lastSuccessAt: null,
  });
}

export function createMicrosoft365ConnectionHealthView({
  connectionService,
  connectionRepository,
  capabilityHealthService,
} = {}) {
  if (!connectionService || typeof connectionService.getConnection !== 'function') {
    throw new TypeError('MICROSOFT365_CONNECTION_SERVICE_REQUIRED');
  }
  if (!connectionRepository || typeof connectionRepository.findByTenantId !== 'function') {
    throw new TypeError('MICROSOFT365_CONNECTION_REPOSITORY_REQUIRED');
  }
  if (!capabilityHealthService || typeof capabilityHealthService.list !== 'function') {
    throw new TypeError('MICROSOFT365_HEALTH_SERVICE_REQUIRED');
  }

  async function enrich(result, tenantContext) {
    const connection = await connectionRepository.findByTenantId(tenantContext.tenantId);
    if (!connection) return Object.freeze({
      ...result,
      capabilities: Object.freeze({
        places: capabilityByName([], 'places'),
        freeBusy: capabilityByName([], 'free_busy'),
        calendarWrite: capabilityByName([], 'calendar_write'),
      }),
    });
    const entries = await capabilityHealthService.list(tenantContext.tenantId, connection.integrationId);
    const placesRuntime = capabilityByName(entries, 'places');
    return Object.freeze({
      ...result,
      capabilities: Object.freeze({
        places: placesRuntime.status === 'not_configured'
          ? connectionCapability(connection, connection.placesPermission, 'places')
          : placesRuntime,
        freeBusy: capabilityByName(entries, 'free_busy'),
        calendarWrite: capabilityByName(entries, 'calendar_write'),
      }),
    });
  }

  return Object.freeze({
    ...connectionService,
    async getConnection(args) {
      return enrich(await connectionService.getConnection(args), args.tenantContext);
    },
    async completeConsent(args) {
      return enrich(await connectionService.completeConsent(args), args.tenantContext);
    },
    async verifyConnection(args) {
      return enrich(await connectionService.verifyConnection(args), args.tenantContext);
    },
    async disconnect(args) {
      return enrich(await connectionService.disconnect(args), args.tenantContext);
    },
  });
}
