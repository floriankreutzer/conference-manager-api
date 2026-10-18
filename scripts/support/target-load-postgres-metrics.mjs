function valid(value) { if (!value) throw new Error('LOAD_POSTGRES_METRICS_FAILED'); }
function amount(value) { valid(Number.isSafeInteger(value) && value >= 0); return value; }

// Shared with the existing loopback load evidence. Counters observe the actual
// pg driver stream (including its TLS mode), not invoice/physical-wire bytes.
// No SQL, parameters, rows, connection strings or client identities are exposed.
export function instrumentLoadPool(pool) {
  valid(typeof pool?.on === 'function');
  const clients = new Set(); let queries = 0; let retiredRead = 0; let retiredWritten = 0; let failed = false;
  function bytes(client) {
    return { bytesRead: amount(client.connection.stream.bytesRead), bytesWritten: amount(client.connection.stream.bytesWritten) };
  }
  pool.on('connect', client => {
    if (clients.size >= 64 || clients.has(client) || typeof client?.query !== 'function'
      || typeof client?.once !== 'function') { failed = true; return; }
    clients.add(client); const query = client.query;
    client.query = function (...args) {
      queries += 1; if (!Number.isSafeInteger(queries)) failed = true;
      return query.apply(this, args);
    };
    client.once('end', () => {
      try {
        const last = bytes(client);
        retiredRead = amount(retiredRead + last.bytesRead); retiredWritten = amount(retiredWritten + last.bytesWritten);
      } catch { failed = true; }
      clients.delete(client);
    });
  });
  return () => {
    try {
      valid(!failed); let bytesRead = retiredRead; let bytesWritten = retiredWritten;
      for (const client of clients) {
        const current = bytes(client); bytesRead = amount(bytesRead + current.bytesRead);
        bytesWritten = amount(bytesWritten + current.bytesWritten);
      }
      return { queries: amount(queries), bytesRead, bytesWritten };
    } catch { throw new Error('LOAD_POSTGRES_METRICS_FAILED'); }
  };
}
