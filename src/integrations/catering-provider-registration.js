import { createProviderRegistry } from './provider-registry.js';

// Manual delivery is an explicit capability, never an API-adapter fallback or delivery implementation.
export function createCateringConfigurationRegistry() {
  return createProviderRegistry({ runtime: 'production', descriptors: [{
    id: 'manual_catering', runtime: 'production', capabilities: {
      'catering.catalogue': 'manual', 'catering.availability': 'manual', 'catering.order': 'manual',
      'catering.update': 'manual', 'catering.cancel': 'manual', 'catering.status': 'manual',
    },
  }] });
}
