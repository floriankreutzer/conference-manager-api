const CHANNEL = 'cm_platform_projection';

// A notification is an empty wakeup only. The durable outbox remains authoritative.
// Exactly one connection is retained and released on failure or explicit shutdown.
export async function subscribePlatformProjectionNotifications(pool, onWake, onDisconnect) {
  if (typeof onWake !== 'function' || typeof onDisconnect !== 'function') {
    throw new TypeError('PLATFORM_PROJECTION_NOTIFICATION_CALLBACK_REQUIRED');
  }
  // Preserve request/worker capacity for a configured single-connection pool.
  // Durable polling still works; a wakeup must never monopolize its only client.
  if (pool.options?.max === 1) return async () => {};
  const client = await pool.connect();
  let closed = false;
  const notification = (message) => {
    if (!closed && message.channel === CHANNEL && message.payload === '') onWake();
  };
  const detach = () => {
    client.removeListener('notification', notification);
    client.removeListener('error', disconnected);
    client.removeListener('end', disconnected);
  };
  const disconnected = () => {
    if (closed) return;
    closed = true;
    detach();
    client.release(new Error('PLATFORM_PROJECTION_LISTENER_DISCONNECTED'));
    onDisconnect();
  };
  client.on('notification', notification);
  client.on('error', disconnected);
  client.on('end', disconnected);
  try {
    await client.query('LISTEN cm_platform_projection');
    if (closed) throw new Error('PLATFORM_PROJECTION_LISTENER_UNAVAILABLE');
  } catch {
    disconnected();
    throw new Error('PLATFORM_PROJECTION_LISTENER_UNAVAILABLE');
  }
  return async () => {
    if (closed) return;
    closed = true;
    client.removeListener('notification', notification);
    try {
      await client.query('UNLISTEN cm_platform_projection');
      client.release();
    } catch {
      client.release(new Error('PLATFORM_PROJECTION_LISTENER_RELEASE_FAILED'));
    } finally { detach(); }
  };
}
