# Read-only protected INT artifact verification

Tracking: CO-320. This is a bounded engineering verification path, not deployment,
product acceptance, persisted Runtime observation or a recurring monitor.

## Purpose and existing ownership

After a qualified paired release, independently reconstruct its sealed artifacts
and compare every served file and API identity before advancing DAST or the
separately qualified Runtime observer. Use the existing sealed-artifact reader,
fixed origins, collector transport checks, size bounds and cancellation limits.
No second HTTP checker or business implementation is introduced.

`verifyProtectedRuntimeArtifacts` accepts positively validated public deployment
selection metadata without a security epoch. It returns an immutable public
report, never the private same-process WeakMap receipt required for persistence.
`collectProtectedRuntimeObservation` still requires the original fixed frontend
allowlist and valid epoch. Its selected release, workflows, database ownership,
migration ledger, routing, freshness, credentials and activation flags are unchanged.

## Native execution

The owning workflow is `.github/workflows/protected-int-runtime-verification.yml`.
It executes only for the repository owner's first-attempt, same-repository change
or explicit Main dispatch, and only while the repository is public. Narrow path
filters limit PR/Main executions to the verification implementation. No schedule,
private paid runner activation, provider resource or new permission is created.
A skipped or unavailable run is not successful verification.

The workflow tests the read-only boundary before allocating the existing CI Reader
App token, which is restricted to source `contents: read`. It separately checks out
the exact deployed API and its committed frontend submodule, without persisted
checkout credentials, and uses that release's unchanged builder with locked
lifecycle-disabled installs. Native candidate/merge identities and the deployed
API/frontend identities remain separate facts.

The two literal source commits, actual provider receipt IDs/timestamps and both
externally qualified manifest digests are reviewed workflow inputs. Never derive
expected digests from the target response or automatically trust build output.
Provider times retain the existing JavaScript-millisecond normalization. Missing
acceptance references remain null. No database binding, epoch, application cookie,
provider credential or business endpoint is allocated to the verifier.

A successful execution requires direct readiness and exact local manifest/profile,
every allowed served file's bytes, length, digest, MIME type, direct HTTP status and
fixed-origin identity, followed by actual API build/version checks. Required
not-ready health fails the workflow. Optional provider state remains unknown or
observed degraded; it is not promoted to healthy. Cold, redirected, malformed,
tampered, wrong-source, oversized or expired evidence is refused.

## Evidence and follow-up

Retain the exact workflow source, native run/job/attempt and public report in Jira.
Local fixture tests prove the verification boundary, not a live HTTP execution.
The report does not establish real provider receipt validity independently of the
release operator's separate Render readback. It cannot be supplied to the Runtime
writer and cannot be converted into an accepted business session.

After an actual successful native read-only run, reconcile the DAST expected pair
and Runtime observer selection through their own normal regression, review,
candidate/Main and activation gates. Do not merge a failing or pending required
check, bypass source protection, reset shared business data, or reuse an old scan
as a new release's result. Authenticated roles/bookings, original-device retests,
real Microsoft/Exchange, independent security and recovery remain separate gates.

The normal repository checks and native permanent Demo/database/browser gates
remain mandatory for changes to the shared collector. This procedure adds no
waiver. An unavailable local network is a reason to use a governed native executor,
not evidence that the application is unavailable or already verified.
