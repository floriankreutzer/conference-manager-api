# SaaS 3.9 — Publishing and Hosted Demo Boundary

## Status

This document records the approved SaaS 3.9 target state. It does not claim that the hosted Demo delivery migration or application-repository visibility cutover is complete.

## Repository boundary

`conference-manager-api` remains private and remains the trusted backend and canonical source of API contracts. Public partner documentation belongs in `conference-manager-developer` and must contain only explicitly approved external artifacts.

The backend source repository must never be made public merely to publish API documentation.

## Public API publication

SaaS 3.9 issue #250 establishes deterministic publication of approved external API contracts from this private repository.

Required properties:
- private backend source remains canonical;
- publication starts from an immutable source commit;
- public material is explicitly allowlisted;
- internal/private endpoints and schemas are excluded by design;
- validation, sanitization or secret-scan failure stops publication;
- public output is versioned and traceable to its source commit;
- contract drift is detected;
- negative tests protect against accidental publication of private-only material.

SaaS 4 #236/#237 own the generic Caterer API contract and documentation content. SaaS 3.9 owns the publication mechanism.

## Hosted Demo transition

Current hosted Demo preparation fetches the exact `DEMO_FRONTEND_REF` from the public `conference-manager` repository using an intentionally anonymous Git environment. That remains the current operational contract until #251 replaces it.

The approved target is a controlled immutable frontend artifact that:
- is traceable to the exact frontend source commit;
- has verifiable integrity;
- fails closed when missing, mismatched or untrusted;
- preserves Customer and Platform same-origin serving and their separate session/API boundaries;
- does not require an ad-hoc long-lived GitHub PAT/deploy key in Render;
- preserves the permanent three-Demo-customer and two-cycle reset acceptance invariant;
- preserves exact immutable cross-repository acceptance.

`conference-manager` must not be made private before a fresh hosted build proves this replacement path.

## Cutover gate

Only SaaS 3.9 #254 performs the final application-source visibility cutover after #247–#253 prerequisites are satisfied. After the cutover, CI, Render, cross-repository acceptance, repository protections, dependency/security gates and public links must be revalidated.

Repository visibility never permits secrets or confidential data in source control. Existing secret, dependency, static/SAST, tenant-isolation and authorization controls remain mandatory.
