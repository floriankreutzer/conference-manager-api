// Closed diagnostic vocabulary. Never retain the original exception or a cause:
// provider, driver and configuration errors can contain confidential values.
const categories=new Map([
    ['PROTECTED_CUSTOMER_RUNTIME_CONFIGURATION_INVALID','configuration'],
    ['PROTECTED_CUSTOMER_RUNTIME_START_FAILED','start'],
    ['PROTECTED_CUSTOMER_RUNTIME_NOT_READY','readiness'],
    ['PROTECTED_FRONTEND_ARTIFACT_INVALID','frontend_artifact'],
    ['PROTECTED_RUNTIME_CONFIG_REQUIRED','configuration_required'],
    ['PROTECTED_RUNTIME_CONFIG_LEGACY_FORBIDDEN','legacy_configuration'],
    ['PROTECTED_RUNTIME_CONFIG_CROSS_SURFACE_FORBIDDEN','cross_surface_configuration'],
    ['PROTECTED_RUNTIME_CONFIG_DATABASE_INVALID','database_configuration'],
    ['PROTECTED_CUSTOMER_CONFIG_UNKNOWN_KEY','unknown_configuration_key'],
    ['PROTECTED_CUSTOMER_CONFIG_VALUE_INVALID','configuration_value'],
    ['PROTECTED_CUSTOMER_CONFIG_SECRET_INVALID','secret_format'],
    ['PROTECTED_CUSTOMER_CONFIG_SECRET_ALIAS_FORBIDDEN','secret_alias'],
    ['PROTECTED_CUSTODY_CONFIGURATION_INVALID','custody_configuration'],
    ['EMAIL_CONFIGURATION_INVALID','mail_configuration'],
    ['ENTRA_FRESH_CLIENT_CONFIGURATION_INVALID','microsoft_configuration'],
]);

const allowed=new Set([...categories.values(),'unavailable']);
export function protectedCustomerStartupCategory(error) {
  const own=error && typeof error==='object' ? Object.getOwnPropertyDescriptors(error) : {};
  const category=own.startupCategory?.value;
  if (allowed.has(category)) return category;
  return categories.get(own.message?.value) ?? 'unavailable';
}
export function createProtectedCustomerStartupFailure(message,error) {
  const failure=new Error(['PROTECTED_CUSTOMER_RUNTIME_START_FAILED','PROTECTED_CUSTOMER_RUNTIME_CONFIGURATION_INVALID']
    .includes(message) ? message : 'PROTECTED_CUSTOMER_PROCESS_FAILED');
  Object.defineProperty(failure,'startupCategory',{ value: protectedCustomerStartupCategory(error) });
  return failure;
}
