export class ApiError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function asApiError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(500, 'INTERNAL_ERROR');
}
