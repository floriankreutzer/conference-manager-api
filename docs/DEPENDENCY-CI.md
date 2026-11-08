# Dependency update CI

CI checks out immutable reviewed counterpart commits and keeps all quality, PostgreSQL,
shared-browser and permanent three-customer/reset gates. Locked installs disable lifecycle
scripts; dependency policy, audit and secret controls remain mandatory.

The optional CI Reader App is used when either App input is configured. Both inputs must then
be valid: partial configuration fails at token creation. Its installation token requests only
contents read access to the two named source repositories. The private key is passed only to
the pinned token action, never to job-wide environment variables.

When both App inputs are absent, such as a Dependabot context without Dependabot secrets,
checkout uses the job's contents-read GitHub token. This can read the current public counterpart
sources; it does not grant access to a separate private repository. Private source/submodule
checkout still fails without the configured CI Reader App and the required authorization.
Restoring private visibility therefore requires the CI Reader inputs in the appropriate Actions
and Dependabot secret contexts. This fallback does not alter visibility, fork permissions,
protected checks, immutable refs, runtime authority or the approved private-source target.

No `pull_request_target`, privileged untrusted-code execution, stored credentials or bypass
of a failed checkout is introduced. Missing cross-repository source is a failed gate, not a skip.
Manual operational and publication workflows retain their existing explicit credentials.

The ordinary CI jobs use the supported `client-id` input of the pinned token action.
The existing `CM_CI_READER_APP_ID` secret name and value are intentionally retained:
at action revision `64ab729a6294000f5aa4a4bc0b73d1f32bc45510`, both input names
feed the same `createAppAuth({ appId: clientId, ... })` path. This is an input-alias
migration, not credential rotation, a new App, or expanded access. Partial App
configuration still fails, the existing public fallback remains limited to absent
App inputs, and post-job token revocation remains enabled. Verify native token
creation, immutable checkout and cleanup separately from the full CI result.
