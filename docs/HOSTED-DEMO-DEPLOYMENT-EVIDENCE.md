# Hosted Demo Deployment Evidence

## Purpose

This document defines the non-secret build identity evidence used by the SaaS 3.5 public Render acceptance gate. It supplements `docs/HOSTED-DEMO-DEPLOYMENT.md` and does not change the Shared Demo authority or persistence model.

The acceptance gate must prove which API commit and immutable frontend commit actually served the tested requests. Static expected SHAs in a GitHub Actions workflow are not sufficient evidence because a Render service can be manually redeployed or rolled back independently of that workflow.

## Build-bound identity

Render provides deployment metadata through its default build/runtime environment. During the existing `npm run demo:hosted:prepare` build step, the API repository creates:

```text
assets/hosted-demo-deployment.json
```

inside the already bounded `.demo-frontend` static root. The file is generated only when `RENDER=true` and contains exactly:

```json
{
  "schemaVersion": 1,
  "provider": "render",
  "repository": "floriankreutzer/conference-manager-api",
  "branch": "main",
  "serviceName": "conference-manager-demo | conference-manager-ops-demo",
  "runtimeRef": "<40-character Render RENDER_GIT_COMMIT>",
  "frontendRef": "<40-character DEMO_FRONTEND_REF>"
}
```

The implementation rejects any Render build whose repository slug, branch, service name, runtime commit format or frontend commit format does not match the closed source-defined contract. Non-Render preparation does not emit provider deployment identity.

## Public evidence endpoint

The existing Demo static handler serves the generated file from each same-origin service:

- `https://conference-manager-demo.onrender.com/assets/hosted-demo-deployment.json`
- `https://conference-manager-ops-demo.onrender.com/assets/hosted-demo-deployment.json`

The file contains no credential, database address, session identifier, CSRF value, HMAC value, provider token, internal exception, SQL detail or customer data. It is intentionally safe to expose as public release evidence.

## Acceptance contract

The frontend repository's Hosted Demo Acceptance workflow must verify both public metadata files before it records a runtime or frontend SHA as deployed evidence and before it starts the destructive cross-role journey.

A valid acceptance requires both services to report:

1. provider `render`;
2. repository `floriankreutzer/conference-manager-api`;
3. branch `main`;
4. the service name matching the origin being tested;
5. the exact reviewed runtime commit expected for the release;
6. the exact immutable frontend commit configured for the release.

Missing metadata, additional fields, malformed SHAs, stale refs, wrong service identity or any other mismatch fail the acceptance closed.

## Release operation

`render.yaml` keeps `autoDeployTrigger: off`. A reviewed merge does not by itself prove the public services are running that commit. The operator must deliberately deploy both Render services from the reviewed API `main` ref. The Hosted Demo Acceptance gate then verifies the build-bound metadata from both live origins before functional acceptance is considered valid.

The evidence file therefore proves the deployed build identity; it does not replace GitHub review/CI evidence, provider readiness, deterministic reset evidence, browser E2E evidence, or the external acceptance record attached to SaaS 3.5.
