import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPrivateBootstrapGrant, requirePlatformPasskeyBootstrapDeliveryContext }
  from './support/platform-passkey-bootstrap-delivery.mjs';

try {
  if (process.argv.length !== 2) throw new Error();
  const context = requirePlatformPasskeyBootstrapDeliveryContext(process.env);
  const temporaryRoot = process.env.RUNNER_TEMP;
  if (typeof temporaryRoot !== 'string' || !isAbsolute(temporaryRoot)) throw new Error();
  const directory = join(temporaryRoot, 'protected-int-passkey-grant');
  // Refuse pre-existing paths before issuance; no overwrite or symlink reuse.
  await mkdir(directory, { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./platform-passkey-offline-grant.mjs', import.meta.url))],
    { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL' });
  const grant = await collectPrivateBootstrapGrant(child, context.request);
  await writeFile(join(directory, 'grant.json'), context.encrypt(grant), { flag: 'wx', mode: 0o600 });
  process.stdout.write('PROTECTED_INT_PASSKEY_BOOTSTRAP_ENCRYPTED\n');
} catch {
  process.stderr.write('PLATFORM_PASSKEY_BOOTSTRAP_DELIVERY_REFUSED\n');
  process.exitCode = 1;
}
