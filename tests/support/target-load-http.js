import http from 'node:http';

// CI-only plaintext edge to the already-owned loopback server. Host is a header,
// never outbound destination authority. No redirect, retry or unbounded response.
export function targetLoopbackJson(server, path, host, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path,
      method: 'GET', headers: { ...headers, Host: host }, agent: false }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8192) request.destroy(new Error('TARGET_TEST_LOOPBACK_HTTP_FAILED'));
        else chunks.push(chunk);
      });
      response.once('end', () => {
        try { resolve({ status: response.statusCode, headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { reject(new Error('TARGET_TEST_LOOPBACK_HTTP_FAILED')); }
      });
    });
    request.setTimeout(2000, () => request.destroy(new Error('TARGET_TEST_LOOPBACK_HTTP_FAILED')));
    request.once('error', () => reject(new Error('TARGET_TEST_LOOPBACK_HTTP_FAILED')));
    request.end();
  });
}
