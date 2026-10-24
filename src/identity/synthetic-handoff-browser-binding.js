import { createCustomerHandoffBrowserBinding } from './customer-handoff-browser-binding.js';

// Preserve the existing wire/MAC protocol, including pending legacy flows.
export function createSyntheticHandoffBrowserBinding(options={}) {
  return createCustomerHandoffBrowserBinding({ ...options,kind: 'synthetic' });
}
