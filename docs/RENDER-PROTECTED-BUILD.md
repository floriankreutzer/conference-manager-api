# Protected INT Render build

Tracking: floriankreutzer/conference-manager#432, INF-04/05. This is a proposed
versioned replacement for the Dashboard inline build command, not a deployed
change or a complete Blueprint migration. The legacy render.yaml remains a CI
dependency and must not be synchronized over the protected INT services.

Build command after qualification:

```sh
node scripts/render-build-protected.mjs
```

Provide the independently qualified nonsecret inputs: PROTECTED_API_COMMIT and
PROTECTED_FRONTEND_COMMIT (full immutable commits), PROTECTED_ENVIRONMENT=int,
PROTECTED_CUSTOMER_ORIGIN, PROTECTED_PLATFORM_ORIGIN and explicit true/false values
for PROTECTED_SYNTHETIC_ENABLED, PROTECTED_PRESENTATION_MICROSOFT_ENABLED,
PROTECTED_PRESENTATION_INVITATIONS_ENABLED and PROTECTED_OWNER_CUSTOMER_ACCESS_ENABLED.
The API pin must identify the actual deployed commit containing this wrapper,
not an earlier audited release or a mutable branch. The wrapper refuses dirty
tracked source and unknown inputs before deleting either fixed build directory.

The wrapper recreates .protected-ui-build and .protected-frontend, refuses symlink
roots, verifies both source commits, installs locked dependencies with lifecycle
scripts disabled, then invokes the reviewed frontend's own sealing builder.
Only nonsecret profile inputs reach that builder. Its minimized output contains
both public manifest digests; those are evidence, not automatic runtime approval.
Configure each service's PROTECTED_HOSTED_FRONTEND_SHA256 independently after
qualification. Never derive and automatically trust the runtime digest at startup.

Private source access must use a separately verified provider-managed HTTPS Git
credential helper or GIT_ASKPASS path. No token-in-URL, anonymous fallback success,
new credential, or credential storage is provisioned by this script. Git runs
without interactive prompts; failed authentication fails the build with a fixed
error. A successful public checkout does not prove private checkout capability.
Subprocess diagnostics are captured and not reflected by the CLI.

Before switching either existing service, verify Blueprint ownership and absence
of conflicting sync, exact source pair, private read access, both independently
reviewed manifests, required CI and both native/browser release gates. Keep Free,
Frankfurt, autoDeployTrigger off, the separate protected Customer/Platform start
commands and their existing readiness paths. Do not introduce duplicate services,
change domain origins, reset data or activate new presentation capabilities.

The full protected Blueprint remains pending actual configuration/ownership
reconciliation; this wrapper is only its build component. The observer selection,
both successful deploy receipts, manifest digests and qualified observer SHA must
be updated together after an actual qualified release. Historical report values
must not be copied into a new active selection as current evidence.

Tests cover repeated stale directories, unrelated-file preservation, invalid
profiles, dirty/mismatched source, symlink escapes, builder environment isolation
and rejected output binding. They use a command adapter and real temporary
filesystem operations: they do not claim an authenticated Render build, actual
artifact sealing or a deployment. Those remain activation gates in INF-04/05.
