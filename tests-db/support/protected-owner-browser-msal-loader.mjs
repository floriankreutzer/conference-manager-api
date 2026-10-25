// Isolated browser-provider fixture only. Production entrypoints never register
// this loader. Redirect only the Platform identity adapter's SDK import; the
// fixture's own import still loads the actual pinned Microsoft SDK.
export async function resolve(specifier,context,nextResolve) {
  if (specifier==='@azure/msal-node' && context.parentURL?.endsWith('/src/platform/identity/entra-client.js')) {
    return { url: new URL('./protected-owner-browser-msal.mjs',import.meta.url).href,shortCircuit: true };
  }
  return nextResolve(specifier,context);
}
