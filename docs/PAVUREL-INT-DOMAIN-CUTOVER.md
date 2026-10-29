# Pavurel INT domain cutover

## Scope and release boundary

This is the preparation contract for
[frontend issue415](https://github.com/floriankreutzer/conference-manager/issues/415)
in SaaS1. It covers the existing protected Customer and Platform services.
The source candidate does not establish a live deployment, provider association,
certificate, identity registration, successful login or active observer.

The frontend companion is
[PR416](https://github.com/floriankreutzer/conference-manager/pull/416), pinned at
`29cabd5cfa2e254a3d9960cb8b016f9da956e1f9`. Its domain-specific build regression
evidence does not substitute for the final exact API/frontend browser acceptance.

| Surface | Canonical origin | Entry | API namespace |
| --- | --- | --- | --- |
| Customer | `https://app.int.pavurel.eu` | `/` | `/api/v1/` |
| Platform | `https://platform.int.pavurel.eu` | `/platform-admin/` | `/api/v1/platform/` |

Each service serves its own sealed browser artifact and API. Both receive the
same exact `PROTECTED_CUSTOMER_ORIGIN` and `PROTECTED_PLATFORM_ORIGIN` values.
The existing generic configuration and frontend builder already support these
origins. No additional domain profile, API host, wildcard allowlist, CORS rule,
cookie Domain or Host bypass is required. The website apex and automatic-mail
sender are separate operating changes. Closed Demo blueprints, hosted-Demo
operator scripts and permanent acceptance pins retain their existing scope.

This candidate follows
[API PR350](https://github.com/floriankreutzer/conference-manager-api/pull/350),
which updates the earlier deployment's actual observer receipts and frontend
pin. Review its final state and rebase this candidate after that work is resolved.
Preserve its actual deployment IDs, timestamps and digests as historical facts;
do not replace them with guessed domain-cutover evidence. Overlap in the fixed
frontend pin, workflow checkout and observer documentation is intentional
follow-up work. The data file is not a declaration that the new domains are live.

**Do not merge this source as a standalone observer refresh.** Changing the
observer origins and frontend pin invalidates the retained pre-cutover selection.
Any Main movement also invalidates `CM_INT_OBSERVER_QUALIFIED_SHA`. Agree a
controlled release window and explicitly stop qualification before a coordinated
merge/cutover. Verify that no collection is still in flight. Record the resulting
observation gap; existing observations can become stale or unknown. Never copy
the old qualification SHA to a new Main merely to resume the schedule.

## Prepare the exact source and artifact pair

1. Select reviewed immutable full API and frontend commit SHAs. Run the required
   native, security and permanent three-customer/two-reset browser gates. The
   protected qualified browser journey must additionally exercise this exact
   API/frontend pair in Chromium and WebKit. An older pinned pair or unit fixtures
   do not prove acceptance of the candidate pair.
2. Build both artifacts from the clean, exact frontend checkout using
   `node scripts/build-protected-frontend.mjs /absolute/api/.protected-frontend`.
   Follow [PROTECTED-HOSTED-FRONTEND.md](PROTECTED-HOSTED-FRONTEND.md). Set the
   selected full source SHAs, `PROTECTED_ENVIRONMENT=int`, and both canonical
   origins above. Retain the reviewed synthetic, participant, owner-access and
   Microsoft/invitation presentation settings; do not enable features merely
   because the domain is ready.
3. Verify each complete manifest with the API's sealed-artifact reader. Record
   both external SHA256 digests and source identities. Give each runtime only
   its own `PROTECTED_HOSTED_FRONTEND_SHA256`. Old-origin manifests fail startup
   even when their bytes are otherwise intact. Rebuilding changes the manifests;
   changing only runtime origins or reusing previous digests is insufficient.
4. Prepare both complete runtime configurations together, retaining production
   security, independent credentials, current custody/epochs, database roles and
   `PROTECTED_PLATFORM_ASSURANCE_MODE=microsoft_mfa`. Domain preparation does not
   grant a migration, reset, credential rotation or change of assurance mode.

## Microsoft registrations and browser sessions

Register and verify the exact HTTPS redirect URIs in the owning existing
Microsoft application registrations before opening the new login paths:

| Registration / purpose | Redirect URI |
| --- | --- |
| Customer login and linking | `https://app.int.pavurel.eu/api/v1/auth/microsoft/callback` |
| Platform login | `https://platform.int.pavurel.eu/api/v1/platform/auth/microsoft/callback` |
| Platform fresh operation proof | `https://platform.int.pavurel.eu/api/v1/platform/auth/microsoft/operation/callback` |
| Customer Microsoft365 admin consent, when that integration is operated | `https://app.int.pavurel.eu/api/v1/integrations/microsoft365/callback` |

The fresh-operation callback is separate from the Platform login callback.
Microsoft365 admin consent is separate from user login and does not follow from
successful authentication. Keep the previous reviewed redirect URIs available
for the defined rollback window; remove them only after rollback is retired.

Existing host-only cookies do not move to the new hosts. Start fresh browser
sessions and complete real Customer login, Platform Microsoft MFA and a fresh
operation proof after release. Do not transfer cookie values, broaden their
Domain, reuse pending authentication URLs or bypass CSRF. Although the apps now
share a parent domain, their origins and session authorities remain distinct.
Verify the fixed-origin synthetic/owner handoffs when those features are enabled.
The selected Microsoft-managed MFA profile needs no application WebAuthn RP-ID
migration; application-passkey activation would be a separate reviewed change.

## Coordinate provider association and runtime activation

Before executing the release, inspect current DNS, TLS, service associations,
build/start commands, runtime origins and health-check configuration for both
services. Previously prepared DNS or a certificate is not proof that the current
association and strict application profile match.

As documented in [Render HTTP health checks](https://render.com/docs/health-checks),
Render uses a verified custom domain as the Host when one is associated.
Therefore adding/verifying a custom domain while the service still expects the
old Host can fail readiness. Conversely, deploying a new-origin-only runtime
while checks still use the old Host can fail readiness. The release operator
must establish a supported provider sequence for matching the health-check Host,
both strict runtime profiles and the staged artifacts within the controlled
window. If that sequence cannot be established, stop the cutover and retain the
previous working configuration. Do not relax Host checks or return artificial
health to cross this boundary.

Open the new entrypoints only after both actual deployments succeed with their
own domains, TLS and expected health/build identities. Confirm Platform `/`
redirects only to `/platform-admin/`, all browser/API requests remain on their
own origin, and the old or sibling Host is rejected by each configured runtime.
Provider-level redirects from an old public URL are not evidence that the
application accepts that Host. Complete the fresh authentication and handoff
checks above; capture failures as failures rather than promoting DNS readiness
to application acceptance.

## Refresh actual observation evidence and qualify separately

After successful release, obtain the real provider deployment IDs and completion
times, deployed API/frontend identities, per-surface manifests and independent
digests. Update `scripts/data/protected-int-runtime-selection.json` in a reviewed
source change using those receipts. Keep the observed API commit separate from
the observer source commit. Never insert predicted deployment IDs, current time
as a deployment time, old digests under new origins or invented evidence links.

The fixed frontend pin and recurring workflow checkout must identify the exact
accepted frontend. Rebuild and measure the full candidate artifacts; the prior
pair's byte and bandwidth estimates do not qualify the new operating budget.
Retain all public-runner, owner, exact-Main, first-attempt, time-window, credential
allocation and exclusion controls in
[PROTECTED-RUNTIME-OBSERVATION.md](PROTECTED-RUNTIME-OBSERVATION.md).

Qualify the final observer Main and reviewed selection with fresh evidence,
then explicitly set `CM_INT_OBSERVER_QUALIFIED_SHA` to that accepted Main for a
controlled owner dispatch. The original one-shot workflow additionally requires
deployed API SHA equal to observer SHA; use the recurring workflow's separately
qualified observer/deployed-source contract when those identities differ. Check
the persisted observation and current mappings before treating recurrence as
operational. The SHA variable enables both dispatch and schedule. Set that variable
and perform the first controlled recurring-workflow dispatch outside 09:00-19:00 Europe/Berlin,
with no collection in flight, so the scheduled preflight cannot race the first
readback. Owner dispatch is permitted outside the window. An actual later
scheduled-event receipt is separate from manual success.
No source merge or repository-variable update by itself proves healthy runtime.

## Rollback and acceptance record

Retain the previously accepted API/frontend pair, both artifacts/digests, runtime
origins, provider association state and redirect registrations before release.
If either surface or fresh authentication fails, keep new traffic closed and
restore that complete matched configuration through the same coordinated
health-check boundary. A source revert alone does not undo provider state or
restore fresh sessions. Preserve genuine failed and successful deployment
receipts; do not rewrite historical observations. Requalify observation only for
the actually restored pair and final observer source.

The acceptance record must distinguish exact-source local checks, CI/security
gates, permanent Demo progression, the protected pair's browser acceptance,
actual provider/TLS/health state, real Microsoft authentication, new sessions,
current handoffs, manual observation and an actual scheduled receipt. Pending
items keep this preparation open. No production website, mail send, data reset,
provider plan change or application deployment is authorized merely by this
document.
