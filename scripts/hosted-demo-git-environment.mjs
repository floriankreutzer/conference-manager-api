import { devNull } from 'node:os';

const FORBIDDEN_PREFIXES = Object.freeze(['GIT_', 'GH_', 'GITHUB_']);
const FORBIDDEN_KEYS = new Set(['SSH_ASKPASS']);

export function createAnonymousGitEnvironment(sourceEnv) {
  if (!sourceEnv || typeof sourceEnv !== 'object' || Array.isArray(sourceEnv)) {
    throw new TypeError('HOSTED_DEMO_GIT_ENVIRONMENT_REQUIRED');
  }

  const environment = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (
      FORBIDDEN_KEYS.has(key)
      || FORBIDDEN_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) continue;
    if (typeof value === 'string') environment[key] = value;
  }

  return Object.freeze({
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_COUNT: '0',
    GCM_INTERACTIVE: 'Never',
  });
}
