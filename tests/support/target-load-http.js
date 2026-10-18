import http from 'node:http';

// CI-only plaintext edge to the already-owned loopback server. Host is a header,
// never outbound destination authority. No redirect, retry or unbounded response.
export function targetLoopbackResponse(server, path, host, {
  headers = {}, method = 'GET', body = null, maxBytes = 8192,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024) {
    throw new Error('TARGET_TEST_LOOPBACK_HTTP_FAILED');
  }
  return new Promise((resolve, reject) => {
    let settled = false; let timer;
    function fail() {
      if (settled) return; settled = true; clearTimeout(timer); reject(new Error('TARGET_TEST_LOOPBACK_HTTP_FAILED'));
    }
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path,
      method, headers: { ...headers, Host: host }, agent: false }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { fail(); request.destroy(); }
        else chunks.push(chunk);
      });
      response.once('error', fail); response.once('aborted', fail);
      response.once('end', () => {
        if (settled) return; settled = true; clearTimeout(timer);
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    timer = setTimeout(() => { fail(); request.destroy(); }, 2000);
    request.once('error', fail); request.end(body);
  });
}

export async function targetLoopbackJson(server, path, host, headers = {}) {
  const result = await targetLoopbackResponse(server, path, host, { headers });
  try { return { ...result, body: JSON.parse(result.body.toString('utf8')) }; }
  catch { throw new Error('TARGET_TEST_LOOPBACK_HTTP_FAILED'); }
}
