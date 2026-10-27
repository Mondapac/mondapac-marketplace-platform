# Runbook: admin account takeover

Part of [incident-response.md](../incident-response.md). Severity scale in [README.md](../README.md).

## Trigger and signals

- Successful admin sign-in from an unknown country or place after several failures.
- Admin actions the owner denies: role or permission changes, switch changes (tax, refund, wallet, languages), data export, publishing.
- An admin reports a second-factor (OTP) prompt they did not start, or a password reset mail they did not request.
- Many admin sessions at once for one account.

## Severity

S1. Incident commander: Ali with Hassan. Business decision: john.

## Automatic actions

| Action | Status |
| --- | --- |
| Lock the account, end all its sessions, record the reason (T5) | Planned in SOC package 3. Needs the rules from package 2 |
| Alert S1 by SMS, call and email | Planned in SOC package 2 |

Until those exist, a human does the manual steps below within 15 minutes.

## Human steps

1. Acknowledge and open the incident log. Call Ali.
2. Contain: disable the admin account with `POST /identity/admin/accounts/:accountId/disable` (needs `identity.admin-account.disable`). This ends every session of the account and voids its open sign-ins. If the person with that permission is the compromised one, use another admin holding it.
3. Reset the second factor with `POST /identity/admin/accounts/:accountId/second-factor/reset`: removes the factor and recovery codes, revokes sessions and mails the account. The owner must enrol a new factor.
4. If several admins may be affected, repeat for each. A global "end all sessions of a role" or read-only admin mode is planned in package 3; fallback is to disable accounts one by one or to change the role's permissions (`PUT /identity/admin/roles/:roleId`).
5. If money switches or payments were touched, ask Ali or john whether to use the payment kill switch (planned in package 3, Ali or john only, behind OTP). Fallback: see [payment-fraud.md](payment-fraud.md).
6. Review the audit trail for the last 24 hours (and further back to the first suspicious sign-in): role changes, new admin invitations, switch toggles, exports, payout-account changes. Run `APP_ROLE=api node dist/audit-verify.js --market <MARKET> --full` to check the chain is intact.
7. Revert unwanted changes through the normal admin functions (restore role, switch back, revoke invitations with `POST /identity/admin/invitations/:invitationId/revoke`). Each revert is audited.
8. Rotate every secret the account could see or change (see [leaked-secret.md](leaked-secret.md)).
9. If any export or customer data view happened, start [customer-data-breach.md](customer-data-breach.md).
10. Re-enable only after the owner has a clean device, a new password (reset by mail) and a new second factor: `POST /identity/admin/accounts/:accountId/enable`.

Every emergency action must write an audit event with actor, reason and target. The existing disable and reset endpoints are audited by the identity module; for any action done outside the app (provider console, host), write the same three fields in the incident log.

## Verification

1. No active session for the account; its sign-in attempts fail.
2. No unexplained admin change since the first suspicious sign-in.
3. Audit chain verifies clean.
4. No new alert for the same actor or source for 24 hours.

## Close-out

Close the incident log, note the notification decision, hold the postmortem. Typical actions: require a second admin to approve role changes, shorter admin sessions, alert on sign-in from a new country (package 1 and 2).
