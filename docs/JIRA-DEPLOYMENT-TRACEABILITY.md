# Jira deployment traceability

Jira release and deployment evidence are separate controls.

- Jira **Release** authority remains the Jira Fix Version assigned to work items.
- Render remains the runtime deployment authority.
- GitHub/Jira deployment evidence is published only after the live Render Customer and Platform pair proves the exact reviewed API and frontend SHAs.
- Normalized deployment environments are `dev`, `int`, `pre`, and `prod`; only environments backed by real services may be enabled.
- The initial implementation enables `int` only.
- GitHub Actions operator environments such as `hosted-demo-initialize` and `live-media-operator` are security/credential boundaries and must not be interpreted as Jira deployment environments.

## INT publication

After a deliberate Render INT deployment and its normal acceptance:

1. Confirm the exact API and frontend SHAs from both live deployment identity artifacts.
2. Run **Publish normalized Jira deployment** from the protected `main` branch.
3. Supply the exact API SHA and frontend SHA.
4. The workflow independently fetches both live identity artifacts and fails closed on any mismatch.
5. Only after both identities match does it create an idempotent GitHub deployment for `environment=int` and mark it successful.
6. GitHub for Jira can then associate the deployment with Jira work through the governed CO-key commit/PR lineage.

A failed, cancelled, stale, malformed or mismatched Render deployment is never reported as successful Jira deployment evidence.
