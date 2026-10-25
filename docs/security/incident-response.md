# Incident response

Applies to every security incident, S1 to S4 (severity table in [README.md](README.md)). Prepared playbooks are in [runbooks/](runbooks/). Roster and rotation are in [on-call-handbook.md](on-call-handbook.md).

## The six phases

| Phase | Goal | Output |
| --- | --- | --- |
| 1. Detect | Someone or something notices | An alert, a report or an observation; open the incident log |
| 2. Triage and set severity | Decide what it is and how bad | Severity S1-S4, a named responder, an incident commander for S1 |
| 3. Contain | Stop the damage from growing | Accounts locked, sessions ended, IPs blocked, secrets revoked, payments paused if needed |
| 4. Eradicate | Remove the cause | Vulnerability fixed, secret rotated, malicious access removed |
| 5. Recover | Return to normal and watch | Services back, extra monitoring for at least 24 hours |
| 6. Blameless review | Learn | Postmortem within 5 business days; actions with owners |

When unsure between two severities, choose the higher one and lower it later.

## Who acts per severity

From plan section 5.

| Level | First responder | Incident commander | Business decision and communication |
| --- | --- | --- | --- |
| S1 | On-call person of the week (Kazem DevOps, Hossein backend or Mojtaba DB) | Ali (CTO) with Hassan | john; customer message with Hadi (product owner) |
| S2 | On-call person | Hassan | Ali if needed |
| S3 | Hossein (backend) or Mojtaba (DB) | Hassan | Not needed |
| S4 | Hassan's weekly review | Not needed | Not needed |

## S1 escalation

1. The alert goes to the on-call person by SMS and call, plus email.
2. If nobody acknowledges within 10 minutes, it goes to the next person in the roster, and again every 10 minutes until someone acknowledges.
3. The person who acknowledges starts the incident log and calls Ali (incident commander).
4. Target: someone is working within 15 minutes, 24/7.

Automatic escalation is planned in SOC package 2. Until then the first person to see an S1 calls the on-call person; if no answer in 10 minutes, calls the next one, then Ali. Numbers: `<on-call phone in the private roster>`.

## Containment tools available today

| Need | Today (manual) | Planned |
| --- | --- | --- |
| Disable an admin account (ends all its sessions and open sign-ins) | `POST /identity/admin/accounts/:accountId/disable`, needs permission `identity.admin-account.disable` | Automatic lock (package 3) |
| Disable a customer account | `POST /identity/admin/customers/:accountId/disable` | Automatic lock (package 3) |
| Reset an admin's second factor (revokes all its sessions, mails the account) | `POST /identity/admin/accounts/:accountId/second-factor/reset` | n/a |
| End all sessions of a role; read-only admin mode | Not available. Disable the affected accounts one by one, or change the role's permissions via `PUT /identity/admin/roles/:roleId` | Package 3 |
| Block an IP | Not available in the app. Use the host or edge firewall once a host is chosen | In-app block list (package 3); Cloudflare WAF as optional add-on (package 6) |
| Stop wallet | `PUT /wallet/admin/settings` (states off, active, paused, frozen; use paused or frozen, off is refused once a Market has history) | Emergency switches with OTP (package 3) |
| Stop refunds, tax invoices | Market config `tax.refundCredit.enabled` and `tax.invoice.enabled` in `config/markets/<MARKET>.json` (config as code: change, review, redeploy) | Switch in Security center |
| Stop all payments | Rotate or disable the key at Stripe, or take checkout offline at the host. No in-app kill switch yet | Payment kill switch (package 3): Ali or john only, behind OTP |
| Rotate a webhook secret or API key | At the provider, then update the server env secret (see [leaked-secret.md](runbooks/leaked-secret.md)) | n/a |

Admin endpoints are used by someone holding the permission, through the admin app or an authenticated client. Do not paste session cookies or tokens into chat.

## Incident log template

Create one log per incident in the private incident tracker `<incident tracker location>`, not in this repository. Keep it append-only: add lines, never rewrite.

```
Incident ID:        <YYYY-MM-DD-nn>
Severity:           S<1-4> (changes listed below with time and reason)
Detected at (UTC and Sydney):
Detected by / source:
Incident commander:
Responder(s):
Summary (what we know, no secrets):

Timeline (UTC, one line each: time - who - action - result)
- 
Decisions (who decided what, why):
- 
Emergency actions (each also written as an audit event: actor, reason, target):
- 
Affected (accounts, sellers, orders, data types, counts):
Customer or regulator notification: not needed / decision pending / done (see oaic-notifiable-data-breaches.md)
Status: open / contained / eradicated / recovered / closed
```

## Communication rules

1. One channel for the incident: a private team-chat thread named with the incident ID. Keep S1 chatter out of general channels.
2. State facts, time and next update time. Do not speculate in writing.
3. Status updates during S1: every 30 minutes to Ali and john until contained, then hourly.
4. Only john (with Hadi) decides what customers, sellers, partners (Stripe, carriers) or authorities are told. Responders do not message customers.
5. Never paste passwords, OTP codes, card numbers, tokens or secrets into chat, tickets or this log. Refer to them by name ("the Drive webhook secret") and say rotated or not.
6. No public statement before john approves the text.

## Evidence handling

1. Security events are append-only; nobody edits or deletes them. If one looks wrong, add a new note in the incident log.
2. Today the evidence is the application logs and the audit trail. The audit trail is hash-chained; verify it with the operator command `APP_ROLE=api node dist/audit-verify.js --market <MARKET> --full` (exit 0 clean, 2 findings, 3 incomplete). Run it early in S1 and S2 involving admins or money.
3. Copy logs relevant to the incident into the private incident folder `<incident evidence location>` (Australian region) before any rotation or restart that could lose them. Note the time range and who copied.
4. Do not alter systems more than needed before evidence is copied, except to stop active harm.
5. Never put secrets, card data or full personal records in evidence copies; mask or reference ids.

## Postmortem template

Blameless: describe systems, decisions and information, not fault. Hold it within 5 business days of closing S1 or S2.

```
Title / Incident ID / Severity / Duration
Summary (3 sentences)
Impact (who and what was affected, data and money; yes/no on personal data)
Timeline (UTC): detection, acknowledgement, containment, recovery
Detection: how found; how long after it started; could we have found it sooner?
What went well
What went badly
Where we got lucky
Root cause(s) and contributing factors
Action items (owner, due date, ticket): prevent, detect faster, respond faster
Decisions about notification (OAIC / individuals) and who made them
Rule or alert changes needed
Runbook changes needed
```

Hassan keeps the action list and reviews it weekly until closed.

## Close-out

1. All phases done, incident log complete, status closed.
2. Notification decision recorded (see [oaic-notifiable-data-breaches.md](oaic-notifiable-data-breaches.md)).
3. Postmortem published to the team; action items ticketed.
4. Runbook updated if a step was wrong or missing.
