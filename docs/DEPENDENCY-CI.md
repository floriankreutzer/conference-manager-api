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
