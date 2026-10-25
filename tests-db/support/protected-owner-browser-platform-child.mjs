import { register } from 'node:module';
register(new URL('./protected-owner-browser-msal-loader.mjs',import.meta.url),import.meta.url);
const { createProtectedPlatformRuntime }=await import('../../src/protected-platform-runtime.js');
let runtime;
async function stop() {
  try { await runtime?.stop();process.exitCode=0; } catch { process.exitCode=1; }
  process.disconnect();
}
process.on('message',message=>{ if (message==='stop') stop(); });
try {
  runtime=await createProtectedPlatformRuntime(process.env);
  const address=await runtime.start();process.send({ type: 'listening',port: address.port });
} catch { process.send({ type: 'failed' });process.exitCode=1;process.disconnect(); }
