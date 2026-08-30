function closeHttpServerWithinDeadline(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        server.closeAllConnections();
      } catch {
        // The timeout remains the authoritative shutdown failure.
      }
      reject(new Error('CUSTOMER_SHUTDOWN_TIMEOUT'));
    }, timeoutMs);
    timeout.unref();

    try {
      server.close((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }
  });
}

export async function shutdownCustomerRuntime({ server, persistence, started, timeoutMs }) {
  try {
    if (started) await closeHttpServerWithinDeadline(server, timeoutMs);
  } finally {
    await persistence?.close?.();
  }
}
