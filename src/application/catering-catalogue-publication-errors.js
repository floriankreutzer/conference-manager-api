export class CateringCataloguePublicationInputError extends Error {
  constructor() {
    super('CATERING_CATALOGUE_PUBLICATION_INPUT_INVALID'); this.name = 'CateringCataloguePublicationInputError'; this.code = this.message;
  }
}
const CONFLICTS = new Set(['source','configuration','catalogue','assignment','review','publication','command','connection','reference']);
export class CateringCataloguePublicationConflictError extends Error {
  constructor(kind) {
    if (!CONFLICTS.has(kind)) throw new TypeError('CATERING_CATALOGUE_PUBLICATION_CONFLICT_INVALID');
    super(`CATERING_CATALOGUE_PUBLICATION_${kind.toUpperCase()}_CONFLICT`);
    this.name = 'CateringCataloguePublicationConflictError'; this.code = this.message;
  }
}
