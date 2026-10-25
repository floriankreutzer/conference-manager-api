import { createCustomerHandoffBrowserBinding } from './customer-handoff-browser-binding.js';

// Separate fixed namespace; synthetic custody can never become REAL owner proof.
export function createOwnerCustomerHandoffBrowserBinding(options={}) {
  return createCustomerHandoffBrowserBinding({ ...options,kind: 'owner_real' });
}
