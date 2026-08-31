import { devNull } from 'node:os';
import path from 'node:path';

const FORBIDDEN_PREFIXES = Object.freeze(['GIT_', 'GH_', 'GITHUB_']);
const FORBIDDEN_KEYS = new Set(['SSH_ASKPASS', 'HOME', 'XDG_CONFIG_HOME', 'CURL_HOME', 'USERPROFILE']);

export function createAnonymousGitEnvironment(sourceEnv, isolatedHome) {
  if (!sourceEnv || typeof sourceEnv !== 'object' || Array.isArray(sourceEnv)) {
    throw new TypeError('HOSTED_DEMO_GIT_ENVIRONMENT_REQUIRED');
  }
  if (typeof isolatedHome !== 'string' || !path.isAbsolute(isolatedHome)) {
    throw new TypeError('HOSTED_DEMO_GIT_HOME_INVALID');
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
    HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    CURL_HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_COUNT: '0',
    GCM_INTERACTIVE: 'Never',
  });
}
