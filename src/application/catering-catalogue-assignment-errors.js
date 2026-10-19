export class CateringCatalogueAssignmentConflictError extends Error {
  constructor(currentRevision) {
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0 || currentRevision >= Number.MAX_SAFE_INTEGER) {
      throw new TypeError('CATERING_ASSIGNMENT_CURRENT_REVISION_INVALID');
    }
    super('CATERING_ASSIGNMENT_REVISION_CONFLICT');
    this.name = 'CateringCatalogueAssignmentConflictError';
    this.code = 'CATERING_ASSIGNMENT_REVISION_CONFLICT';
    this.currentRevision = currentRevision;
  }
}
