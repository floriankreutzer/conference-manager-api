# Release source evidence

Tracking: application issue #301. The Release source evidence workflow calls the shared,
immutable Website tool pinned in `.github/workflows/release-evidence.yml`. The public
[canonical tool contract](https://github.com/floriankreutzer/conference-manager-website/blob/7dbf952ce36d1b5153b8f39112f511ec13bd21a9/docs/RELEASE-EVIDENCE.md)
defines inventory, source identity, counterpart binding, verification and limitations.
Do not copy the implementation into this repository.

Every PR/Main candidate generates a lockfile-only CycloneDX 1.5 npm inventory, exact Git
source archive and binding manifest. The command runs from this repository's checkout;
the separate `.release-tool` checkout supplies code, not the inventoried package root.
Its isolated one-dependency locked install runs with lifecycle scripts disabled and a
high-severity audit gate. Existing source/dependency/security/counterpart checks remain
required. No runtime dependency, application behavior, schema or live deployment changes.

Public Main additionally signs all three outputs with GitHub attestations, verifies the
expected repository/workflow/source, and must reject actual tampered bytes and a wrong
source identity. PRs receive no signing permission. On private GitHub Free/Pro/Team,
the signing job is explicitly skipped because native attestations are unavailable;
unsigned inventory integrity requires independently trusted GitHub run/artifact digests
and committed source. It does not provide an equivalent signature or SLSA level.

Artifacts expire after three days. Before expiry, retain the minimized SBOM, manifest,
attestation where available, and exact CI/source/deployment references in protected
release evidence. Do not publish private source, credentials or operational/customer data.
The manifest identifies a source candidate, not a running image or successful deployment.
Tie deployed source and counterpart identities to actual provider readback and retain
independent readiness/recovery evidence before accepting a release.
