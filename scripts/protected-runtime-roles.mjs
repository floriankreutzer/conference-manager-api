import { protectedRuntimeRoleGrantPlan } from './support/protected-runtime-role-grants.mjs';

// Review only: this CLI has no database/provider client and no apply action.
// Explicit operator application uses the separate checked grant port.
try {
  const [action,environment,securityEpoch,...extra]=process.argv.slice(2);
  if (action!=='plan' || extra.length) throw new Error('INVALID');
  const plan=protectedRuntimeRoleGrantPlan({ environment,securityEpoch });
  process.stdout.write(JSON.stringify({ applied: false,plan },null,2)+'\n');
} catch {
  process.stderr.write('PROTECTED_RUNTIME_ROLE_PLAN_INVALID\n');process.exitCode=1;
}
