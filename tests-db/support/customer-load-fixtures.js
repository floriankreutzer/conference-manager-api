export { seedLoadSessions } from '../../scripts/support/target-load-sessions.mjs';

export function instrumentLoadPool(pool) {
  const clients = new Set();
  let queries = 0;
  pool.on('connect', (client) => {
    clients.add(client);
    const query = client.query;
    client.query = function (...args) { queries += 1; return query.apply(this, args); };
  });
  return () => ({ queries, bytesRead: [...clients].reduce((sum, c) => sum + c.connection.stream.bytesRead, 0),
    bytesWritten: [...clients].reduce((sum, c) => sum + c.connection.stream.bytesWritten, 0) });
}
