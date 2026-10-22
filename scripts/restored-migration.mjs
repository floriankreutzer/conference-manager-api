import { runRestoredMigration, restoredMigrationFailureCode } from './support/restored-migration-environment.mjs';

try {
  if (process.argv.length !== 2) throw new Error('REFUSED');
  const result = runRestoredMigration(process.env);
  if (result.normalizedSourceAlias) process.stdout.write('RESTORED_SOURCE_ALIAS_NORMALIZED\n');
  if (result.discardedToolchainMetadata) process.stdout.write('RESTORED_RUNNER_TOOLCHAIN_METADATA_DISCARDED\n');
  process.stdout.write('PROTECTED_INT_RESTORE_MIGRATION_SUCCEEDED\n');
} catch (error) {
  process.stderr.write(`${restoredMigrationFailureCode(error)}\n`);
  process.exitCode = 1;
}
