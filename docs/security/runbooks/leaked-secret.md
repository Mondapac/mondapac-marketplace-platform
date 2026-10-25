# Runbook: leaked secret or service key

Part of [incident-response.md](../incident-response.md).

## Trigger and signals

- GitHub secret scanning alert (to be turned on in the repository settings by john; part of SOC package 4).
- A key, token, password or webhook secret seen in code, a commit, a log, a ticket, chat or a screenshot.
- Provider notice (for example Stripe) about a leaked key.
- Unexpected use of a key: unknown API calls, webhooks with valid signatures from an unknown source.

## Severity

S1 for a Stripe key, database credential, admin credential, or any key that moves money or reads customer data. S2 for a low-impact key (for example an analytics key). The incident commander for S1 is Ali.

## Automatic actions

GitHub alert only (once secret scanning is on). No automatic revoke. Alert delivery to the on-call person is planned in SOC package 2; until then, whoever reads the GitHub alert calls the on-call person.

## Secrets that exist in the code today

Names only, set as server environment secrets, never in the repository:

| Secret (env name) | What it protects | Where to rotate |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Stripe API (test mode only today) | Stripe dashboard, API keys |
| `STRIPE_WEBHOOK_SECRET` | Signature check of Stripe webhooks, one per Market endpoint | Stripe dashboard, webhook endpoint of the Market |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Signature check of Stripe Connect webhooks | Stripe dashboard, Connect endpoint |
| `DRIVE_API_KEY` | Calls to Mondapac Drive | Drive admin; `<Drive key rotation procedure>` |
| `DRIVE_WEBHOOK_SECRET` | Signature check of Drive webhooks | Drive and the server, see step 5 |
| Throttle secret (identity sign-in counters) | Keys of sign-in rate counters | Server secret store; rotating only resets counters |
| Uber Direct, Zoom2u secrets | `<not in code yet; confirm when those carriers are integrated>` | Provider console |
| Database credentials, session and encryption secrets, email and SMS provider keys | `<confirm env names in the deployment config; no host chosen yet>` | Provider or host secret store |

## Human steps

1. Acknowledge. Do not copy the secret into chat or the log; write its name only.
2. Revoke at the provider at once. Do not wait to find out whether it was used. Create the new secret.
3. Put the new secret in the server secret store (nothing is deployed yet; the store depends on the host chosen), restart or redeploy the affected service, and confirm it works.
4. Remove the secret from where it leaked: delete the file or message, and if it was committed, treat the secret as public forever. History rewriting is optional and never replaces rotation.
5. Webhook secrets: Stripe and Drive can sign with an old and a new secret during rotation (the Drive check accepts several `v1` signatures). Create the new secret at the provider, deploy it, then remove the old one. A signature failure spike right after means the app and provider disagree on the secret.
6. Check for use of the old secret: provider logs (Stripe dashboard events and API logs), unexpected charges, refunds, payouts, new webhook endpoints, new API keys. Check the audit trail for the same window.
7. If the secret gave access to customer data, start [customer-data-breach.md](customer-data-breach.md). If it was a Stripe live key, also [payment-fraud.md](payment-fraud.md).
8. Record the rotation in the incident log (name, time, who). A secret rotation done at a provider is an emergency action: write actor, reason and target in the log; the app writes the audit event only for actions done through it.

## Verification

1. Old secret refused by the provider.
2. New secret in use; webhooks verify; checkout test passes in test mode.
3. Secret scanning shows the alert resolved.
4. No suspicious activity for 24 hours.

## Close-out

Postmortem: how did it get there? Actions: add the pattern to scanning, move the secret to the store, review who has access. Closing needs Hassan's sign-off for S1.
