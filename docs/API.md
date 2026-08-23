# API Foundation Contract

## Base path

The browser uses the same public HTTPS origin as the API. API paths are relative and live below `/api/`. The foundation version prefix is `/api/v1`.

CORS is not enabled for the normal application flow.

## Response contract

Successful foundation responses are JSON with `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.

Every response receives a server-generated `X-Request-Id`. JSON success/error payloads include the same request ID where useful for support correlation.

Errors use:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "requestId": "server-generated-uuid"
  }
}
```

Stack traces, SQL details, provider payloads, credentials, tokens, environment configuration, and internal exception messages are not part of the public error contract.

## Endpoints

### `GET /api/v1/health/live`

Returns HTTP 200 while the service process can handle requests.

```json
{
  "status": "ok",
  "requestId": "..."
}
```

### `GET /api/v1/health/ready`

Returns HTTP 200 with `ready` when all registered dependency checks complete successfully within the configured bound. Returns HTTP 503 with `not_ready` on failure, rejection, or timeout.

The response never enumerates internal dependency names or configuration.

### `GET /api/v1/session`

Protected server-principal context. Returns HTTP 401 by default until issue #50 installs the real principal/session resolver.

When authenticated:

```json
{
  "user": { "id": "internal-user-uuid" },
  "tenant": { "id": "internal-tenant-uuid" },
  "roles": ["employee"],
  "requestId": "..."
}
```

The browser may use this response for presentation. It does not become authorization input when values are sent back in later requests.

## Request boundary

- Allowed methods: GET, POST, PUT, PATCH, DELETE.
- TRACE/CONNECT and other methods fail closed.
- Host must match the configured public origin.
- A present browser `Origin` header must match the configured public origin exactly.
- Backslashes, encoded path separators, malformed percent encoding, and dot-segment traversal are rejected before routing.
- State-changing JSON endpoints added later must use `readJsonObjectBody` plus an explicit positive schema such as `validateExactObject`.
- Unknown fields are rejected by the positive-schema helper.
- Request bodies are bounded before and during stream consumption.
- Non-identity content encoding is rejected by the JSON parser until a reviewed decompression policy exists.
