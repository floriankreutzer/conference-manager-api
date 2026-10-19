export class CateringProviderCatalogueInputError extends Error {
  constructor() {
    super('CATERING_PROVIDER_CATALOGUE_INPUT_INVALID');
    this.name = 'CateringProviderCatalogueInputError'; this.code = this.message;
  }
}
export class CateringProviderCatalogueConflictError extends Error {
  constructor(code) {
    if (!['CATERING_PROVIDER_CATALOGUE_REVISION_CONFLICT','CATERING_PROVIDER_CATALOGUE_CONFIGURATION_CONFLICT',
      'CATERING_PROVIDER_CATALOGUE_COMMAND_CONFLICT','CATERING_PROVIDER_CATALOGUE_SOURCE_UNAVAILABLE'].includes(code)) {
      throw new TypeError('CATERING_PROVIDER_CATALOGUE_CONFLICT_INVALID');
    }
    super(code); this.name = 'CateringProviderCatalogueConflictError'; this.code = code;
  }
}
