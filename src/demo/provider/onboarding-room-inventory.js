// Synthetic external directory candidates, not imported application rooms.
// Only the source-defined Fabrikam provider Tenant owns these resources.
const FABRIKAM_PROVIDER_TENANT = '40000000-0000-4000-8000-000000000004';
const EMPTY_INVENTORY = Object.freeze([]);
const FABRIKAM_ROOMS = Object.freeze([
  Object.freeze({
    id: 'fabrikam-workshop',
    displayName: 'Fabrikam Workshop',
    resourceAddress: 'fabrikam-workshop@example.invalid',
    capacity: 12,
    building: 'Fabrikam Demo Campus',
  }),
  Object.freeze({
    id: 'fabrikam-focus',
    displayName: 'Fabrikam Focus',
    resourceAddress: 'fabrikam-focus@example.invalid',
    capacity: 6,
    building: 'Fabrikam Demo Campus',
  }),
]);

export function demoOnboardingProviderRooms(providerTenantReference) {
  return providerTenantReference === FABRIKAM_PROVIDER_TENANT
    ? FABRIKAM_ROOMS : EMPTY_INVENTORY;
}
