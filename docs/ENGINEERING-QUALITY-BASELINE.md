# Incremental JavaScript quality baseline

Tracking: `floriankreutzer/conference-manager#300`.

The native ESM architecture remains unchanged. Biome 2.5.15 is an exact-locked, development-only
correctness linter. It adds no application runtime dependency, framework, bundler, build step or
provider SDK. The CLI and all platform-specific optional lock entries declare MIT OR Apache-2.0,
which satisfies the existing reviewed license subset without choosing an unapproved license or
changing the allowlist. Locked installs retain integrity hashes and disable lifecycle scripts.
Existing security/SAST, secret, architecture, dependency and test controls remain separate gates.

Tool selection evidence: an initial ESLint 10.13.0 candidate passed scoped correctness probes but
failed the actual application license-policy regression because its transitive graph introduced
BSD-2-Clause, BSD-3-Clause, ISC and BlueOak-1.0.0. That failed evaluation is retained as historical;
its packages/configuration are not selected, and the license gate was not weakened. ESLint 9.39.4
was also rejected after the registry reported it unsupported. Biome's final locked graph passes
the existing policy. Native CLI artifacts are development executables, not browser/backend modules.

`npm run check:lint` runs Biome with the explicit repository biome.json, warnings treated as errors,
no write/fix option and bounded source roots. The configuration selects core correctness rules for
undefined variables, duplicate keys/branches, invalid assignments, unreachable code, unsafe optional
chaining, invalid built-in use and related errors. Formatter and assists are disabled: linting cannot
reformat source or reorganize imports. Tests execute invalid snippets through the real locked CLI
and verify rule diagnostics, plus a valid ESM/no-fix case. This is not exhaustive semantic analysis.

The baseline deliberately does not adopt every recommended/stylistic rule. Generic noUnsafeFinally
would flag deliberate fail-closed cleanup/restoration failures, and control-character regex rules
would flag positive security validation. Existing cleanup/error and validation tests remain
mandatory; those runtime paths are not rewritten for generic style advice. Parenthesized regular-
expression iteration and unused interface bindings do not justify unrelated cleanup. Any suppression
or configuration reduction requires review under the existing no-gate-weakening requirements.

Formatting decision: use the repository's deterministic whitespace/style checks, not a second
whole-source formatter during provider work. This is a minimal whitespace baseline, not full AST
formatting or a claim that linting proves Clean Code/SOLID. Both new commands are invoked by the
existing npm run check, so the existing CI quality job enforces them without workflow changes.
No security assertion, browser/reset gate, branch protection, retry or timeout is weakened.

Before extending a provider-related hotspot, record its owning responsibility, public consumers,
reuse/extraction choice and characterization/regression evidence in the PR. Keep cohesive modules
intact; otherwise extract one responsibility, migrate consumers through approved contracts, remove
dead bridges/imports and rerun applicable architecture/security/database/browser gates. File length
is a review signal, never an automatic split target. Final SaaS 4 evidence must disclose material
remaining hotspots. New provider foundation contracts stay outside HTTP/booking/Microsoft internals.

API coverage includes src, scripts, tests and tests-db. Existing check:style remains unchanged,
including its 140-character limit, and is also exposed as check:format. Biome built-in global
recognition is not Tenant/Node authority; current architecture and security gates remain the boundary.

Adoption removes one identical duplicate empty catalogueMedia property from the Fabrikam fixture.
The semantic checksum before and after remains
`7e22005f1e9689fbea4ccfc75084f5f3d224fe10e60a6af23c1cb600f2b70014`.
The regression locks that accepted checksum; no semantic seed/version/migration change is claimed.
Permanent database and paired three-customer/two-reset gates still apply.
