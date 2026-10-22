import { runRestoredMigration } from './support/restored-migration-environment.mjs';

try {
  if (process.argv.length !== 2) throw new Error('REFUSED');
  runRestoredMigration(process.env);
  process.stdout.write('PROTECTED_INT_RESTORE_MIGRATION_SUCCEEDED\n');
} catch {
  process.stderr.write('RESTORED_MIGRATION_REFUSED\n');
  process.exitCode = 1;
}
