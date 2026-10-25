# On-call handbook

For Kazem (DevOps), Hossein (backend) and Mojtaba (DB). Process in [incident-response.md](incident-response.md); severity table in [README.md](README.md).

> Nothing is deployed and no cloud host is chosen. Pager-style alert delivery is planned in SOC package 2; until then S1 reaches you by a person's phone call or message. Adjust this handbook when the tooling exists.

## Rotation

1. Weekly rotation among three people: Kazem, Hossein, Mojtaba. Change over on Monday at 09:00 Sydney time `<confirm day and time with the team>`.
2. The roster, order and phone numbers are in the private roster `<on-call phone in the private roster>`. They are not stored in this repository.
3. The next person in the roster is the escalation target. Ali (incident commander) is the final step; john for business decisions.
4. Swaps are allowed if both agree and the roster is updated before the shift starts.

## Handover checklist (outgoing to incoming)

- [ ] Open incidents and their status; open alerts not yet acknowledged.
- [ ] Actions still pending from earlier incidents or postmortems.
- [ ] Switches or limits changed on purpose (read-only, paused wallet, tightened rate limits) and when to revert.
- [ ] Planned deployments, migrations or provider maintenance this week.
- [ ] Secrets rotated recently and anything still to rotate.
- [ ] Phone and notification test: incoming person confirms they received a test call and SMS.
- [ ] Access test: can reach the repository, hosting console `<host not chosen>`, Stripe dashboard, the incident tracker, the audit-verify command.

## What to carry

1. Phone on, loud, with the roster, and mobile data.
2. A laptop or a way to reach the admin app and the hosting console within 15 minutes.
3. Your own accounts with a second factor ready. Never share accounts.
4. This repository's `docs/security/`, available offline.
5. Rights: you must hold the permissions you may need (identity admin-account disable, wallet admin) or know who does.

## Acknowledgement and escalation

1. Acknowledge S1 within 15 minutes of the alert: call or message Ali and open the incident log.
2. If nobody acknowledges within 10 minutes, the alert goes to the next person, and again every 10 minutes (automatic in package 2; manual by phone until then).
3. Chain: on-call person, next on-call person, then the third, then Ali. Ali involves Hassan; john is told for any S1 with money, data or customer impact.
4. If you are unreachable for a reason, say so in advance and swap.

## S1 versus business hours

| Level | When | Rule |
| --- | --- | --- |
| S1 | 24/7 | Respond within 15 minutes, even at night |
| S2 | 09:00-18:00 Sydney, Mon-Fri | Within 1 hour; if the alert arrives outside these hours, first thing next morning. If you find it is really S1, raise it |
| S3 | Business hours | Same business day |
| S4 | Weekly | Hassan's weekly review |

On-call people do not work S2-S4 at night. Use judgement: an S2 that looks like it is turning into an S1 becomes S1.

## Logs and data

1. Security events: 90 days hot (fast to query), then archived for 12 months, then deleted by the retention job (planned in SOC package 1). The retention job is the only deleter; nobody edits or deletes events.
2. Until package 1 exists, keep application logs and the audit trail at least as long as the host allows and copy incident evidence to the incident folder.
3. Financial records follow Australian tax record-keeping rules separately and are not governed by the security log retention. Ask john or the accountant before deleting anything financial.
4. All security data stays in an Australian region. Do not copy logs to personal devices or overseas tools.
5. Never log passwords, OTP codes, card numbers, tokens or secrets.

## Budget and paid add-ons

1. Monthly security budget cap is A$250 (decision T10, for phase 0 and 1; reviewed in phase 2).
2. Paid services (Cloudflare WAF, Sentry paid tier, SMS volume beyond the free allowance) are optional add-ons, OFF by default (T1). An admin may enable one later from the panel and pays for it. The registry and panel for add-ons are planned in SOC packages 5 and 6.
3. Do not subscribe to a paid tool during an incident without Ali or john approving; use the manual fallback.
4. If a month's cost would exceed the cap, tell john.

## Quarterly tabletop exercise

1. Every three months, about 2 hours on paper (no production changes), led by Hassan.
2. Pick an invented incident (for example an admin takeover at 02:00, a leaked Stripe key, a customer data export found online).
3. Walk through the six phases with the real roster: who is called, in what order, what each person does, which runbook applies, what the fallback is where a tool is only planned.
4. Time the S1 response on the roster path. The phase 1 gate needs a first exercise done and S1 response under 15 minutes.
5. Record findings and update the runbooks. The notification decision (OAIC) is practised with john.

## Security gates

1. Phase 0 (before real payments): Hassan's review with no open critical finding (T9). Phase 0 includes the event format, admin action audit, CSP report endpoint, edge protection decision, Radar, secret scanning and the S1 runbooks.
2. Phase 1 (at launch): rules, Security center page, SMS and escalation, on-call rotation, emergency switches, first exercise done.
3. Independent penetration test after launch (T9), done by an outside provider. It is separate from the SOC budget (one-off, roughly A$10,000-30,000 in the plan; verify before booking).
4. Phase 2 (3-6 months after launch): decide on a managed SIEM or outside SOC based on real volume.

## Quick reference

| I need to | Go to |
| --- | --- |
| Run an incident | [incident-response.md](incident-response.md) |
| Admin account misuse | [runbooks/admin-account-takeover.md](runbooks/admin-account-takeover.md) |
| Key leaked | [runbooks/leaked-secret.md](runbooks/leaked-secret.md) |
| Customer data out | [runbooks/customer-data-breach.md](runbooks/customer-data-breach.md) |
| Money moving wrongly | [runbooks/payment-fraud.md](runbooks/payment-fraud.md) |
| Failed sign-in wave | [runbooks/credential-stuffing.md](runbooks/credential-stuffing.md) |
| Strange script | [runbooks/unknown-script-csp.md](runbooks/unknown-script-csp.md) |
| Vulnerable library | [runbooks/vulnerable-dependency.md](runbooks/vulnerable-dependency.md) |
| Legal notification | [oaic-notifiable-data-breaches.md](oaic-notifiable-data-breaches.md) |
