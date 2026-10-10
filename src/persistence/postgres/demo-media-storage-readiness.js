export class DemoMediaStorageReadinessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DemoMediaStorageReadinessError';
    this.code = code;
  }
}

export async function assertDemoMediaStorageReady(pool, { mode, expectedDatabaseName, expectedRole } = {}) {
  if (!pool || typeof pool.query !== 'function' || !['postgres', 'neon'].includes(mode)
    || !/^conference_manager_demo_[a-z0-9_]{1,48}$/.test(expectedDatabaseName || '')
    || !/^[a-z][a-z0-9_]{2,62}$/.test(expectedRole || '')) {
    throw new TypeError('DEMO_MEDIA_STORAGE_READINESS_CONFIG_INVALID');
  }
  try {
    const identity = await pool.query({ name: 'demo-media-storage-identity',
      text: 'SELECT current_user AS role, current_database() AS database' });
    if (identity.rows.length !== 1 || identity.rows[0].role !== expectedRole
      || identity.rows[0].database !== expectedDatabaseName) {
      throw new DemoMediaStorageReadinessError('DEMO_MEDIA_STORAGE_IDENTITY_INVALID');
    }
    // Startup/operator preflight only: bounded existence checks, never provider I/O
    // or media bytes on readiness polls. Mixed states require an offline cutover.
    const result = await pool.query({ name: 'demo-media-storage-mode',
      text: `SELECT (
        EXISTS (SELECT 1 FROM public.tenant_room_media_assets
          WHERE ($1::boolean AND object_key IS NULL) OR (NOT $1::boolean AND object_key IS NOT NULL) LIMIT 1)
        OR EXISTS (SELECT 1 FROM public.demo_catalogue_media_assets
          WHERE ($1::boolean AND object_key IS NULL) OR (NOT $1::boolean AND object_key IS NOT NULL) LIMIT 1)
      ) AS inconsistent`,
      values: [mode === 'neon'] });
    if (result.rows.length !== 1 || result.rows[0].inconsistent !== false) {
      throw new DemoMediaStorageReadinessError('DEMO_MEDIA_STORAGE_MODE_MISMATCH');
    }
  } catch (error) {
    if (error instanceof DemoMediaStorageReadinessError) throw error;
    throw new DemoMediaStorageReadinessError('DEMO_MEDIA_STORAGE_READINESS_FAILED');
  }
}
