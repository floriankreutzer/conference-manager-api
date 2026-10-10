export async function closeNeonRecoveryResources(closeOperations) {
  let failed = false;
  for (const close of closeOperations) {
    await Promise.resolve().then(() => close()).catch(() => { failed = true; });
  }
  if (failed) {
    process.exitCode = 1;
    process.stderr.write('NEON_RECOVERY_CLEANUP_FAILED\n');
  }
  return !failed;
}
