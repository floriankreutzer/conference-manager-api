import { createProtectedCustomerRuntime } from './protected-customer-runtime.js';

async function run() {
  const runtime=await createProtectedCustomerRuntime(process.env);
  const stop=()=>{ runtime.stop().catch(()=>{ process.exitCode=1; }); };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  await runtime.start();
}
run().catch(()=>{
  process.stderr.write('PROTECTED_CUSTOMER_PROCESS_FAILED\n');process.exitCode=1;
});
