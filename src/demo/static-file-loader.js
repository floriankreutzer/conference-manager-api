const STATIC_FILE_ADAPTER_MODULE = './static-file-adapter.mjs';

export async function loadDemoStaticFileAdapter(root) {
  if (root === null || root === undefined) return null;
  if (typeof root !== 'string' || !root) throw new TypeError('DEMO_STATIC_ROOT_REQUIRED');
  const module = await import(STATIC_FILE_ADAPTER_MODULE);
  if (typeof module.createDemoStaticFileAdapter !== 'function') {
    throw new TypeError('DEMO_STATIC_FILE_ADAPTER_MODULE_INVALID');
  }
  return module.createDemoStaticFileAdapter({ root });
}
