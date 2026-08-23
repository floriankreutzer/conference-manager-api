export class TenantUnavailableError extends Error {
  constructor() {
    super('TENANT_UNAVAILABLE');
    this.name = 'TenantUnavailableError';
  }
}

export class TenantInputError extends Error {
  constructor() {
    super('TENANT_INPUT_INVALID');
    this.name = 'TenantInputError';
  }
}

export class TenantRepositoryContractError extends Error {
  constructor() {
    super('TENANT_REPOSITORY_CONTRACT_VIOLATION');
    this.name = 'TenantRepositoryContractError';
  }
}
