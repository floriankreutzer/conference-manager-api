import { loadTargetScope } from './target-load-guard.mjs';
import { targetScopeValues } from './target-load-runtime-config.mjs';

function valid(value) { if (!value) throw new Error('LOAD_OPERATOR_CONFIG_INVALID'); }

// An explicit execution host mode, never a removed/spoofed RENDER guard.
export function loadTargetOperatorConfig(env, now = Date.now()) {
  try {
    const scope = loadTargetScope(targetScopeValues(env), now);
    const name = `cm-saas38-load-${scope.runId}-operator`;
    const origin = `https://${name}.onrender.com`;
    valid(scope.surface === 'setup' && env.LOAD_OPERATOR_MODE === 'render-one-shot-v1'
      && env.RENDER === 'true' && env.RENDER_GIT_REPO_SLUG === 'floriankreutzer/conference-manager-api'
      && env.RENDER_GIT_BRANCH === 'main' && env.RENDER_GIT_COMMIT === scope.releaseSha
      && env.RENDER_SERVICE_TYPE === 'web' && env.RENDER_SERVICE_NAME === name
      && env.RENDER_EXTERNAL_HOSTNAME === `${name}.onrender.com` && env.RENDER_EXTERNAL_URL === origin
      && typeof env.LOAD_OPERATOR_TOKEN === 'string' && /^[A-Za-z0-9_-]{43}$/.test(env.LOAD_OPERATOR_TOKEN)
      && env.LOAD_OPERATOR_TOKEN !== scope.observerToken);
    const port = env.PORT ?? '10000';
    valid(typeof port === 'string' && /^[1-9][0-9]{0,4}$/.test(port)
      && Number(port) <= 65535 && ![18012, 18013, 19099].includes(Number(port)));
    return Object.freeze({ scope, origin, port: Number(port), token: env.LOAD_OPERATOR_TOKEN });
  } catch { throw new Error('LOAD_OPERATOR_CONFIG_INVALID'); }
}
