import { createProtectedPlatformRuntime } from './protected-platform-runtime.js';

async function run() {
  const runtime=await createProtectedPlatformRuntime(process.env);
  const stop=()=>{ runtime.stop().catch(()=>{ process.exitCode=1; }); };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);await runtime.start();
}
run().catch(()=>{ process.stderr.write('PROTECTED_PLATFORM_PROCESS_FAILED\n');process.exitCode=1; });
