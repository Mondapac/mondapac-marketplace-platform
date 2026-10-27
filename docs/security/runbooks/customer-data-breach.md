# Runbook: customer data breach

Part of [incident-response.md](../incident-response.md). Legal side: [oaic-notifiable-data-breaches.md](../oaic-notifiable-data-breaches.md).

## Trigger and signals

- Bulk reads of customer or seller records; unusual database queries on customer tables; a seller reading another seller's orders.
- Customer data found outside the platform (paste site, report from a customer or researcher).
- Lost laptop or backup holding personal data.
- A takeover ([admin-account-takeover.md](admin-account-takeover.md)) or leaked secret ([leaked-secret.md](leaked-secret.md)) that gave data access.
- A data export by an unexpected actor.

## Severity

S1. Incident commander: Ali with Hassan. Business decision and notification: john with Hadi.

## Automatic actions

None (plan section 5). Detection signals (data export events, unusual access) are planned in SOC package 1 and 2. Database auditing (pgaudit or host equivalent) depends on the host, which is not chosen yet.

## Human steps

1. Acknowledge, open the incident log, call Ali. Start the assessment clock: record the time you first suspected a breach. The notifiable data breach assessment must finish within 30 days, and faster is expected.
2. Contain: stop the access path. Disable the account used (`POST /identity/admin/accounts/:accountId/disable` or `POST /identity/admin/customers/:accountId/disable`), rotate the secret used, close the exposed endpoint or bucket at the host. Do not delete data; deleting destroys evidence and does not undo the exposure.
3. Preserve evidence: copy the relevant logs and audit entries to the incident folder before restarting or rotating anything that rotates logs. Run `APP_ROLE=api node dist/audit-verify.js --market <MARKET> --full`.
4. Scope with Mojtaba (DB) and Hossein (backend): which tables, which fields, how many people, which Markets, which time window, which sellers. Personal data types: names, emails, addresses, phone numbers, order history. Card numbers are not stored by Mondapac (cards go through Stripe hosted fields); confirm that statement against the data found.
5. Eradicate: fix the cause (permission check, query, secret), deploy, test.
6. Notification assessment (john with Ali and Hassan, legal advice): follow [oaic-notifiable-data-breaches.md](../oaic-notifiable-data-breaches.md). If serious harm is likely and remediation cannot prevent it, notify OAIC and the affected people.
7. Draft the customer message with Hadi: what happened, what data, what we did, what people should do, how to contact us. No unverified claims. john approves.
8. Notify partners if their data or keys are involved (Stripe, carriers) as john decides.

## Emergency actions and audit

Every emergency action (disable account, switch, rotation, export block) writes an audit event with actor, reason and target. Switch changes through the app are audited; for host or provider steps, write the same three fields in the incident log.

## Verification

1. The access path is closed and tested.
2. The scope list (people, fields, period) is complete and recorded.
3. No new unusual access for 72 hours.
4. Notification decision recorded with reasons, whichever way it went.

## Close-out

Postmortem within 5 business days. Keep the assessment record (see OAIC note). Actions: tighter permissions, query limits, export approvals, field masking in logs.
