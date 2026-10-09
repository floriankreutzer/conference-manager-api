# Manual real-Neon adapter acceptance

Tracking: frontend issue #264. This gate is a provider adapter probe, **not**
application authorization, coordinated database/object restore, browser/reset
acceptance, production backfill, cutover or permission to purge PostgreSQL bytes.

## Why this separate gate exists

The accepted four-row CI matrix uses an isolated S3 protocol fixture. Hosted #497
uses retained PostgreSQL media. Local direct DNS/SDK access returned EAI_AGAIN or
safe unavailability, while provider-level signed curl transfers succeeded. None
of those results proves the unchanged application's SDK works against Neon.

`Neon Object Adapter Acceptance` runs manually on accepted API `main` using Node 22
and the exact locked dependencies. It calls `createNeonObjectStorage` without a
client factory, custom transport, proxy, retry or deadline override. The only
allowed destination is the existing isolated branch `br-falling-glade-b17oqqiv`
and its private `conference-manager-media` bucket. No database compute, Function,
new service, bucket, production credential or tariff change is required.

## Protected setup and execution

1. Independently verify the named branch and private bucket before execution.
2. Create a temporary credential **on that branch**, with `storage:write` scope.
   An ancestor/production credential is not acceptable. Neon scopes are branch-
   bound and cover descendants; they are not bucket-level isolation policies.
3. Set API repository Actions secrets `CM_NEON_ACCEPTANCE_ACCESS_KEY_ID` from the
   full `token_id`, and `CM_NEON_ACCEPTANCE_SECRET_ACCESS_KEY` from
   `s3_secret_access_key`. Do not use `token_id_short` or `api_token`, and do not
   paste credentials into conversation, workflow inputs, source or logs.
4. Run **Neon Object Adapter Acceptance** once on `main` after required PR gates
   pass. Inspect its exact source SHA and retained JSON artifact.
5. Revoke the temporary Neon credential immediately after the run, independently
   confirm `revoked_at`, and remove both temporary Actions secrets. Expiration
   alone is not provider-enforced revocation. Failed/cancelled runs require the
   same cleanup. Do not delete or reset the branch or its 34 retained objects.

The job has read-only GitHub permissions, pinned actions, no checkout credential
retention, no automatic trigger and no parallel cancellation. It installs locked
dependencies without lifecycle scripts and passes secrets only to the probe step.
It runs on the existing allowed GitHub capacity; this does not authorize a paid
runner, higher spending limit or unrelated provider compute.

## Evidence and failure semantics

Each invocation generates unique synthetic Tenant/asset UUIDs and a tiny fixed PNG.
It uploads through the unchanged adapter, independently compares exact returned
bytes, requires an anonymous HTTP 403, deletes only its exact synthetic key, and
requires the adapter's missing-object classification on readback before passing.
Even an ambiguous failed PUT triggers exact-key deletion. Unknown failures never
become a success. No user upload, canonical image or existing key is overwritten.

Bounded JSON retains source SHA, fixed isolated destination, synthetic key, byte
length/digest and fixed verification booleans. It excludes credentials, raw
provider errors, database connection data, URLs with signatures and user data.
An intent artifact is written exclusively before provider I/O, so the exact key
is retained even if the runner terminates before a final result. If cleanup fails,
this synthetic key is the operator's exact cleanup target. Recording failure
prevents provider I/O. A lost runner without a retrievable artifact remains an
unresolved custody check, not proof of an empty bucket. Preserve canonical custody.

Success unblocks the SDK-specific provider gate only. The full real-provider
application/paired recovery/three-customer/two-reset gates remain mandatory before
production switching or blob removal. Never replace or weaken the existing CI
matrix, hosted acceptance or restore-evidence digest requirement with this probe.
