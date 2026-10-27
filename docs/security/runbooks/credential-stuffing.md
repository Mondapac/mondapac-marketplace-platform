# Runbook: credential stuffing and password guessing

Part of [incident-response.md](../incident-response.md).

## Trigger and signals

- Many failed sign-ins in a short time, from many accounts or many IPs (example rule: 10 failed logins in 5 minutes per account or per IP; rules are planned in SOC package 2).
- Spike in password-reset requests, sign-up attempts, or rate-limit refusals (HTTP 429).
- Customers reporting sign-in mails they did not trigger, or accounts they did not use.
- One account with a successful sign-in right after a long run of failures.

## Severity

S2 for a wave against seller or customer accounts. S1 if an admin account signed in after the failures (also run [admin-account-takeover.md](admin-account-takeover.md)). S4 for scattered failures.

## What exists today

The API already counts sign-in attempts and refuses when a limit is reached. Counters are kept in PostgreSQL, keyed by HMAC of account, origin and account plus origin (no raw emails or IPs in the keys). Limits are set per Market in `config/markets/<MARKET>.json`: `identity.signInThrottles` (`accountOrigin`, `account`, `origin`), `identity.mailThrottles`, and the generic per-origin limiter `requestLimits` (`anonymousIdentityPerMinute`, `publicMediaPerMinute`, `defaultPerMinute`). Passwords are hashed with argon2id and admins have a second factor, so a guessed password alone does not open an admin account.

## Automatic actions

| Action | Status |
| --- | --- |
| Per-account and per-origin refusal at the configured limit | Exists |
| Harder limits, auto lock of targeted accounts, in-app IP block list (T5) | Planned in SOC package 3 |
| Block IPs at the edge (Cloudflare WAF) | Optional paid add-on, OFF by default; planned in SOC package 6. No host chosen yet |

## Human steps

1. Acknowledge. Measure: which accounts, which IPs or ranges, which Market, success or failure, since when. Use the application logs (package 1 events will give one searchable table).
2. Tighten: lower `identity.signInThrottles` and `requestLimits` values in the Market config by pull request (reviewed by Hassan), deploy. Emergency changes still go through the repository, never by editing a server by hand.
3. Block abusive IPs at the host or edge firewall (the in-app list arrives in package 3). Prefer blocking ranges with evidence; avoid blocking shared addresses without checking.
4. Targeted accounts: disable those with a suspected successful sign-in (`POST /identity/admin/customers/:accountId/disable`); sellers via the seller team tools. Ending sessions: disabling revokes sessions.
5. Force a password change for targeted accounts: send reset mails through the normal reset flow. Do not set passwords for people and do not send passwords by any channel.
6. If successful sign-ins to real accounts are confirmed, check those accounts for changes (addresses, payout account, orders) and run [payment-fraud.md](payment-fraud.md) and, if data was viewed, [customer-data-breach.md](customer-data-breach.md).
7. Customer message (john with Hadi): short notice to affected users to change reused passwords.

## Verification

1. Failure rate back to baseline for 2 hours.
2. No successful sign-in from the abusive sources after blocking.
3. Targeted accounts reset or disabled with a recorded reason.

## Close-out

Record the final limits and the block list in the incident log (IPs may be recorded in the log because they are needed for follow-up; no passwords). Review the thresholds with Hassan; revert emergency tightening when the wave ends. Postmortem for S1 and S2.
