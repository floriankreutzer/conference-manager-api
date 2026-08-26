export function createPostgresConfigurationDomainRepository({
  store,
  domain,
  initialize,
  applyProjection,
} = {}) {
  if (
    !store
    || typeof store.current !== 'function'
    || typeof store.commit !== 'function'
    || typeof store.listHistory !== 'function'
    || typeof store.revision !== 'function'
    || typeof store.rollback !== 'function'
  ) {
    throw new TypeError('CONFIGURATION_REVISION_STORE_REQUIRED');
  }
  if (typeof initialize !== 'function' || typeof applyProjection !== 'function') {
    throw new TypeError('CONFIGURATION_DOMAIN_ADAPTER_REQUIRED');
  }

  return Object.freeze({
    current(tenantId) {
      return store.current({ tenantId, domain, initialize });
    },
    listHistory(tenantId, limit) {
      return store.listHistory({ tenantId, domain, initialize, limit });
    },
    revision(tenantId, revision) {
      return store.revision({ tenantId, domain, initialize, revision });
    },
    update(args) {
      return store.commit({
        ...args,
        domain,
        initialize,
        applyProjection,
      });
    },
    rollback(args) {
      return store.rollback({
        ...args,
        domain,
        initialize,
        applyProjection,
      });
    },
  });
}
