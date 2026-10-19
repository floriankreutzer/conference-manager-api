# Integration credential encryption component

Tracking: `floriankreutzer/conference-manager#133` and `#232` (partial infrastructure).

`src/persistence/integration-credential-cipher.js` encrypts bounded opaque credential bytes using
Node's AES-256-GCM implementation, a fresh random 96-bit nonce and a 128-bit authentication tag.
The versioned server-only envelope contains only schemaVersion, keyId, nonce, tag and ciphertext.
Encoding is canonical unpadded base64url. Plaintext is 1–8192 bytes. Algorithms/tag sizes cannot be
selected through an envelope. Unknown fields, accessors, hidden/symbol properties, invalid formats
and excessive lengths fail closed before cryptographic processing.

Authenticated associated data binds the envelope schema/domain and key ID to the internal Tenant,
Integration, source-registered provider, Credential ID, credential version and explicit purpose.
Provider-authentication and partner-authentication purposes cannot substitute for one another.
UUID spelling is canonicalized, but identities and versions cannot be changed without failing
authentication. Moving ciphertext to a different Tenant/connection/provider/version is not a valid
credential migration. Callers must derive this expected scope from independently authorized server
records, never a browser/provider payload or metadata copied from the encrypted envelope.

Trusted server composition supplies at most eight independently managed 256-bit keys and selects
one active key ID. The component copies key bytes; later caller mutation cannot change its keys.
Writes use only the active key; retained IDs can read older envelopes during a controlled rotation.
A re-encryption must preserve the trusted scope and atomically replace the exact expected version.
Missing keys and authentication failure expose only INTEGRATION_CREDENTIAL_UNAVAILABLE. Raw provider
bytes, cryptographic library errors and decrypted data must never enter public API/audit/log fields.
Keys must remain separate from database/backup data, sourced through existing protected server
configuration; no actual keys, environment variables or deployment settings are introduced here.

The caller owns and must clear returned plaintext buffers after the bounded provider operation.
Failed/successful decryption clears its intermediate unverified buffer. destroy clears the component's
copied key buffers and prevents subsequent use. This is limited best-effort memory cleanup in a
JavaScript process; it is not a guarantee against runtime memory copies or a compromised server.

This component is not a secret store, authorization policy, revocation check or replay/rollback
defense. Replaying a complete older valid record can still authenticate under its old scope;
authoritative current-version, active-connection and revocation checks remain mandatory. Before use,
the application must authenticate/authorize the actor and Tenant, load current credential custody,
reject stale/disabled scope, and bind writes/rotation to transactional concurrency and minimized audit.
Database ownership/constraints, credential ingestion and revocation, runtime key loading/rotation,
graceful-shutdown integration and actual provider use remain separate work. No browser route,
plaintext database column, external request, provider credential or Production activation is added.

Regression tests execute real authenticated encryption, scope/tamper/wrong-key/key-ID-alias denial,
old/new key rotation, retired-key failure, input bounds, noncanonical encoding, accessor rejection,
caller-mutation isolation and shutdown denial. These component tests do not establish deployed
key custody, Tenant repository authorization, audited rotation or live provider acceptance.
