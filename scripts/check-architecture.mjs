import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(current));
    else if (entry.name.endsWith('.js')) files.push(current);
  }
  return files;
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const runtimeDependencies = packageJson.dependencies || {};
if (JSON.stringify(runtimeDependencies) !== JSON.stringify({ pg: '8.23.0' })) {
  throw new Error('The reviewed PostgreSQL driver must remain the only runtime dependency for this persistence slice.');
}

const files = await sourceFiles('src');
for (const file of files) {
  const content = await readFile(file, 'utf8');
  if (file !== 'src/config.js' && /process\.env/.test(content)) {
    throw new Error(`${file} accesses process.env directly; runtime configuration belongs in src/config.js.`);
  }
  if (/from ['"](?:node:)?(?:fs|child_process|vm)['"]/.test(content)) {
    throw new Error(`${file} imports a privileged runtime module outside the approved foundation.`);
  }
  if (/https?:\/\//.test(content) && file !== 'src/config.js') {
    throw new Error(`${file} contains a hard-coded outbound URL; provider destinations require an approved integration boundary.`);
  }
  if (/x-tenant-id|x-tenant-context/i.test(content)) {
    throw new Error(`${file} introduces a client-controlled tenant header into the trusted runtime.`);
  }
  if (/from ['"]pg['"]/.test(content) && !file.startsWith('src/persistence/postgres/')) {
    throw new Error(`${file} imports the database driver outside the PostgreSQL infrastructure adapter boundary.`);
  }
  if (/\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(content) && !file.startsWith('src/persistence/postgres/')) {
    throw new Error(`${file} contains SQL outside the PostgreSQL infrastructure adapter boundary.`);
  }
}

const app = await readFile('src/app.js', 'utf8');
if (!app.includes("'/api/v1/health/live'") || !app.includes("'/api/v1/health/ready'") || !app.includes("'/api/v1/session'")) {
  throw new Error('Required foundation route contracts are missing.');
}
if (!app.includes('createPrincipalGuard') || !app.includes('assertSameOrigin') || !app.includes('createRateLimiter')) {
  throw new Error('Required API security boundaries are not composed in src/app.js.');
}
if (!app.includes('createTenantContextGuard') || !app.includes('tenantGuard.requireKnown(principal)')) {
  throw new Error('Protected session context must resolve the tenant from the authenticated principal.');
}

const tenantContext = await readFile('src/tenancy/tenant-context.js', 'utf8');
if (!tenantContext.includes('loadTenant(principal.tenantId)')) {
  throw new Error('Tenant context must load the internal tenant ID from the authenticated principal.');
}
if (/request\.|headers|searchParams|queryParam/i.test(tenantContext)) {
  throw new Error('Tenant context must not derive authority from request-controlled routing or headers.');
}

const tenantRepository = await readFile('src/tenancy/tenant-scoped-repository.js', 'utf8');
for (const method of [
  'findByTenantIdAndId',
  'listByTenantId',
  'insertForTenant',
  'updateByTenantIdAndId',
  'deleteByTenantIdAndId',
]) {
  if (!tenantRepository.includes(method)) {
    throw new Error(`Tenant repository contract is missing scoped adapter method ${method}.`);
  }
}
if (/\.findById\(|\.updateById\(|\.deleteById\(/.test(tenantRepository)) {
  throw new Error('Tenant repository must not expose unscoped object access methods.');
}

const tenantModel = await readFile('src/tenancy/tenant.js', 'utf8');
for (const resourceType of [
  'user',
  'site',
  'room',
  'service',
  'request',
  'notification',
  'integration',
  'entitlement',
  'audit_event',
]) {
  if (!tenantModel.includes(`'${resourceType}'`)) {
    throw new Error(`Tenant ownership inventory is missing ${resourceType}.`);
  }
}

const persistence = await readFile('src/persistence/postgres/index.js', 'utf8');
if (!persistence.includes('isPostgresSchemaReady') || !persistence.includes('createPostgresTenantRepository')) {
  throw new Error('PostgreSQL persistence must enforce schema readiness and provide Tenant loading.');
}

for (const migration of [
  'migrations/001_core_tenant_schema.up.sql',
  'migrations/001_core_tenant_schema.down.sql',
]) {
  await readFile(migration, 'utf8');
}

console.log('Architecture boundary check passed.');
