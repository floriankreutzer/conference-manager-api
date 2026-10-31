# Protected INT Render build

Tracking: floriankreutzer/conference-manager#432, INF-04/05. `render.int.yaml`
describes both existing protected INT services. The legacy `render.yaml` remains
a separate CI dependency and must not be synchronized over protected INT.

## Current release selection

`render.int.yaml` selects the wrapper activation pair documented in
[the infrastructure release runbook](INFRASTRUCTURE-20261031-WRAPPER-RELEASE.md).
Its immutable API/frontend pins, build command and both independently verified
manifests move together. This is a configuration selection, not a deployment
receipt. Keep automatic Blueprint sync paused and require the exact candidate,
independent Main and provider gates in that runbook before manual application.
The earlier [schema75 QA release](QA-20261031-RELEASE.md) and the following
30 October receipts remain historical evidence. This release adds no migration.

## Historical Blueprint adoption — 30 October 2026

The existing Blueprint `conference-manager-demo` (`exs-daakihlg1s2s73df6jdg`)
owns both services and `conference-manager-demo-shared`. At the administration
readback on 2026-10-30 it uses Main/render.yaml with automatic sync paused.
Change that Blueprint's path to `render.int.yaml`; do not create a second
Blueprint or new services. Keep automatic sync paused. Inspect the provider's
proposed changes before any manual sync; existing resource IDs, Free plans,
Frankfurt, disabled previews/auto-deploy, origins and readiness paths must match.

The Blueprint follows Main, but both services select the separately frozen Git
branch `release/int-20261030-ca1f06b` at
`ca1f06b5b5181965f7c3aeffdc235aa44c638771`. Its GitHub ruleset must be active,
target exactly that branch, prohibit updates, deletion and force pushes, and have
no bypass actors. Verify both the ref and effective rules before syncing. This
keeps a fresh build independent of later Main movement; selecting Main would
make the existing exact-source build guard reject a rebuild.

On 2026-10-30 both existing services were changed to that branch using Dashboard
Save changes with auto-deploy off. Provider readback confirmed the branch and
the unchanged live deploy receipts: Customer `dep-dbibkggu01pc7397eb40` and
Platform `dep-dbibkjnlk1mc73fr97gg`. This configuration-only adoption did not
trigger a deploy. The active exact-branch ruleset is `26239613`, with no bypass.

A subsequent manual Blueprint sync can redeploy the existing qualified source pair; inspect the
proposed resources and then verify both real deploy receipts, manifest digests
and readiness. No service code, data, schema or secret is migrated by that sync.
Record the new receipts in the observer selection only after actual success;
the existing receipts remain historical evidence rather than guessed new IDs.
For a future release, create and protect a new immutable release branch and
update the Blueprint's pair, source guards and digests together after qualification.

The previous Blueprint snapshot froze the actually deployed API `ca1f06b5b5181965f7c3aeffdc235aa44c638771`
and frontend `2ddcf3859505fe62a46ac008fb1d6e9059711bbb`, including the existing
literal build guards and clean frontend clone. It intentionally does not activate
the newer wrapper merely by adopting IaC. Source selection, runtime pins and
both independently reviewed frontend digests must change together in a separately
qualified paired release. Do not sync this dated snapshot if another release or
domain migration has since changed those values; reconcile the file first.

Both artifact digests were independently reproduced and matched to the actual
Render build logs; they and the public service version are pinned explicitly.
At 2026-10-30 19:33 UTC the canonical collector also verified every served sealed
file against those independently rebuilt artifacts and read both public health
and status endpoints. This read-only in-memory check did not persist an observer
record, exercise database credentials, or prove recurring freshness.
Credentials, epochs, provider identity/owner inputs, current Node version/pool
bounds and participant flag are explicit `sync: false` inputs. These
are prompts only on initial creation; Render ignores them when updating an
existing Blueprint, retaining current values. New required inputs must therefore
be entered separately and verified. Never generate or rotate keys during adoption.
The legacy group remains owned but unlinked: its existing omitted values survive,
and forbidden `DEMO_*` inputs must not enter either protected runtime. Verify the
actual linked-group state before applying; do not detach a live dependency blindly.

The Blueprint provisions no database, worker, disk, paid compute or extra service.
Independent existing data/provider resources and their restricted credentials are
operator inputs, not resources to recreate. Dashboard-only workspace billing,
quotas and private repository credentials remain external administration tasks.

## Qualified build-wrapper activation

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

The wrapper removes the obsolete .protected-ui-build cache and recreates
.protected-frontend, refuses symlink roots, verifies both source commits, installs
locked dependencies with lifecycle scripts disabled, then invokes the reviewed
frontend's own sealing builder in the provider-initialized submodule.
Only nonsecret profile inputs reach that builder. Its minimized output contains
both public manifest digests; those are evidence, not automatic runtime approval.
Configure each service's PROTECTED_HOSTED_FRONTEND_SHA256 independently after
qualification. Never derive and automatically trust the runtime digest at startup.

The reviewed frontend is now the separate Gitlink `vendor/protected-frontend`,
pinned to `df6bbb678286bdcf9d9a0a450273001d691e4574`, the consistent OPS cards
and private daily-source frontend candidate in frontend PR440. Require its complete
candidate/Main acceptance before selecting a paired release. The legacy
`vendor/demo-frontend` and its Demo contract are unchanged. Render documents that
it initializes Git submodules using its connected Git-provider credentials:
<https://render.com/docs/git-provider#git-submodules>. The existing Render
installation must retain read access to both API and frontend repositories.

The wrapper requires a real initialized submodule directory, matching committed
Gitlink mode/SHA, exact checkout root/HEAD and clean frontend source before
installation or cache deletion. It performs no clone, fetch or checkout and has
no anonymous fallback, token-in-URL, GIT_ASKPASS input or new credential store.
An empty uninitialized submodule cannot fall through to the API repository's Git
root. Provider authentication failure therefore prevents preparation, rather than
silently creating an unrelated public checkout. Subprocess diagnostics are
captured and not reflected by the CLI. A successful build while sources are
public still does not prove actual private-state delivery: retain that separate
2 November cutover readback in frontend issue310.

Before switching either existing service, verify Blueprint ownership and absence
of conflicting sync, exact source pair, private read access, both independently
reviewed manifests, required CI and both native/browser release gates. Keep Free,
Frankfurt, autoDeployTrigger off, the separate protected Customer/Platform start
commands and their existing readiness paths. Do not introduce duplicate services,
change domain origins, reset data or activate new presentation capabilities.

The versioned wrapper is selected by the infrastructure release configuration;
activation is complete only after both actual services and their receipts match
the separately qualified paired release. A merged YAML file alone is not live evidence. Keep
the presentation flags scoped to the build command, as in the captured inline
command: the runtime deliberately rejects `PROTECTED_PRESENTATION_*` variables.
Do not add those build-only keys to either service's persistent environment.
The observer selection,
both successful deploy receipts, manifest digests and qualified observer SHA must
be updated together after an actual qualified release. Historical report values
must not be copied into a new active selection as current evidence.

Tests cover repeated stale directories, unrelated-file preservation, invalid
profiles, dirty/mismatched API and frontend source, missing/uninitialized Gitlinks,
wrong Gitlink mode/SHA, symlink escapes, builder environment isolation and rejected
output binding. They use a command adapter and real temporary
filesystem operations: they do not claim an authenticated Render build, actual
artifact sealing or a deployment. Those remain activation gates in INF-04/05.
