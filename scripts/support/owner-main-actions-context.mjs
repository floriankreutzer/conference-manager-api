export function requireOwnerMainActionsContext(env, workflow) {
  const repository = 'floriankreutzer/conference-manager-api';
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_ACTOR !== 'floriankreutzer'
    || env.GITHUB_TRIGGERING_ACTOR !== 'floriankreutzer' || env.GITHUB_RUN_ATTEMPT !== '1'
    || env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/${workflow}@refs/heads/main`
    || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '') || env.EXPECTED_MAIN_SHA !== env.GITHUB_SHA
    || [env.RUNNER_DEBUG, env.ACTIONS_STEP_DEBUG, env.ACTIONS_RUNNER_DEBUG, env.NODE_OPTIONS].some(Boolean)) {
    throw new Error('OWNER_MAIN_ACTIONS_REFUSED');
  }
}
