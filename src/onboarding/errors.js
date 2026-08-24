export class OnboardingInputError extends Error {
  constructor(code = 'ONBOARDING_INPUT_INVALID') {
    super(code);
    this.name = 'OnboardingInputError';
    this.code = code;
  }
}

export class OnboardingDeniedError extends Error {
  constructor(code = 'ONBOARDING_UNAVAILABLE') {
    super(code);
    this.name = 'OnboardingDeniedError';
    this.code = code;
  }
}

export class OnboardingConflictError extends Error {
  constructor(code = 'ONBOARDING_CONFLICT') {
    super(code);
    this.name = 'OnboardingConflictError';
    this.code = code;
  }
}
