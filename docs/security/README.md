# Security operations (SOC) runbooks

Operational documentation for the Mondapac security operations centre (SOC). Source of truth: the approved SOC plan (version 1, 25 Oct 2026) and the SOC build handoff (owner decisions T1-T10).

> Status: nothing is deployed and no cloud host is chosen yet. Where a step depends on a host, a provider console or a capability that is not built, it says so and gives the manual fallback that works with the code as it is today.

## Contents

| Document | Use it when |
| --- | --- |
| [incident-response.md](incident-response.md) | Any security incident: the six phases, roles per severity, log and postmortem templates |
| [on-call-handbook.md](on-call-handbook.md) | You are on call, handing over, or running the quarterly exercise |
| [oaic-notifiable-data-breaches.md](oaic-notifiable-data-breaches.md) | Personal data may have been accessed, disclosed or lost |
| [runbooks/admin-account-takeover.md](runbooks/admin-account-takeover.md) | An admin account is used by someone else |
| [runbooks/leaked-secret.md](runbooks/leaked-secret.md) | A key, token or password appeared where it should not |
| [runbooks/customer-data-breach.md](runbooks/customer-data-breach.md) | Customer or seller personal data was exposed |
| [runbooks/payment-fraud.md](runbooks/payment-fraud.md) | Stolen cards, fake refunds, payout-account changes |
| [runbooks/credential-stuffing.md](runbooks/credential-stuffing.md) | Mass failed sign-ins or password guessing |
| [runbooks/unknown-script-csp.md](runbooks/unknown-script-csp.md) | An unknown script or CSP violation on a page, especially checkout |
| [runbooks/vulnerable-dependency.md](runbooks/vulnerable-dependency.md) | A dependency has a known vulnerability |

## Scope: five monitored areas

Ordered by potential damage (plan section 2).

| Area | What is watched | Main threat |
| --- | --- | --- |
| Admin actions | Role and permission changes, switches (tax, refund, wallet, languages), publishing, data export | Admin account takeover or insider misuse |
| Payments | Stripe events, refunds, wallet top-ups, seller payout-account changes | Stolen cards, fake refunds, changed seller bank account |
| Authentication | Failed sign-ins, admin OTP, password reset, parallel sessions, sign-in from a new country | Password guessing, leaked passwords, OTP bypass |
| Data access | Bulk reads of customer data, unusual database queries, one seller reading another seller's orders | Personal data breach (Australian Privacy Act) |
| Shop traffic | Request rates, bots, CSP reports, 4xx and 5xx, price scraping, abuse of the shopping assistant | Injection, malicious script on a page, denial of service |

Out of scope in phase 1: team members' personal devices and the office network. The code repository and GitHub are in scope because secret leaks start there.

## Severity table

Response time runs from the moment the alert arrives until one person starts work. Business hours are 09:00-18:00 Australia/Sydney (decision T3).

| Level | Examples | Channels (T4) | Response time |
| --- | --- | --- | --- |
| S1 critical | Successful admin sign-in from an unknown place after several failures; data breach; Stripe key in code; payout accounts of several sellers changed within one hour | SMS and call, plus email, plus Security center page | 15 minutes, 24/7 |
| S2 high | Wave of failed sign-ins on seller accounts; Stripe Radar fraud warning; unknown script on the payment page | Email and team chat, plus page | 1 hour in business hours; next morning if outside them |
| S3 medium | High-severity vulnerability in a dependency; price scraping; webhook signature failure | Page plus daily digest | Same business day |
| S4 low | Scattered failed sign-ins; repeated CSP report from a browser extension | Weekly report | Weekly review |

Automatic alert delivery (SMS, email, chat, digest) is planned in SOC package 2. Until then a person raises the alert by phone or chat using the roster below.

## Roles

| Role | Person | Notes |
| --- | --- | --- |
| On-call responders (weekly rotation) | Kazem (DevOps), Hossein (backend), Mojtaba (DB) | Phone on for S1 during the week |
| Incident commander (S1) | Ali (CTO) | Decides containment; one of two people who may use the payment kill switch |
| Security owner | Hassan (security testing) | Commands S2-S4, weekly alert review, rule tuning (about 4 h per week), reviews security changes |
| Business decision and customer communication | john, with Hadi (product owner) | Decides notification, customer messages, payment kill switch (with Ali) |

Contact details live only in the private on-call roster: `<on-call phone in the private roster>`. Do not put phone numbers in this repository.

## Status of SOC packages

| # | Package | Status | What exists today instead |
| --- | --- | --- | --- |
| 1 | Security events foundation: append-only events table, `SecurityEvents.record()`, retention job | Planned (in progress) | Ordinary application logs and the existing hash-chained audit trail |
| 2 | Rules and alert delivery: thresholds, alerts table, delivery by severity, 10-minute S1 escalation | Planned | Manual watching and phone calls |
| 3 | Automatic actions and emergency switches: auto lock, session revoke, in-app IP block list, read-only admin mode, payment kill switch | Planned | Existing admin endpoints (disable account, reset second factor), provider consoles, config change and redeploy |
| 4 | External signals: CSP report endpoint, Stripe fraud and dispute events, `.github/dependabot.yml`, GitHub secret scanning | Planned | Manual checks in the Stripe dashboard and GitHub settings |
| 5 | Security center admin page (design first, with Reza) | Planned (design phase) | None |
| 6 | Optional paid add-ons, first Cloudflare WAF, all OFF by default | Planned | None |
| 7 | These runbooks | This document set | n/a |

Rule for every document here: "planned in SOC package N" means the capability is not available yet; use the manual fallback given next to it.

## Fixed rules

1. Security events are append-only. No admin can edit or delete them; only the retention job deletes (after 12 months).
2. Never log or paste passwords, OTP codes, card numbers, tokens or secrets.
3. Every emergency action writes an audit event: actor, reason, target.
4. Data stays in an Australian region.
5. Paid services are optional add-ons, OFF by default; monthly security budget cap A$250.
