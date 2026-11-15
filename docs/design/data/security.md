# Security module data design (SOC package 2: rules and alert delivery)

Status: built 2026-11-14 under speed mode (docs/process/speed-mode.md), from the owner's SOC plan
(decisions T1-T10, 2026-10-25) and the security centre design (decision D2). Package 1
(security events) is in docs/design/data/platform.md section 13. database-designer sign-off is
part of the PR's combined review.

## 1. Scope

The `security` module reads the security events of package 1, applies a closed catalogue of
rules, opens alerts, delivers them by severity to the on-call roster, and lets an administrator
acknowledge and resolve them. It owns the schema `security`. It never writes an event, never
changes another module's data, and never acts on an alert by itself (automatic actions are
package 3).

## 2. Tables (schema `security`)

Migration `20261114000000_security_alerts`. Every table carries `market_id` and `tenant_id`
with the platform CHECKs. Nothing is ever deleted: a trigger refuses DELETE and TRUNCATE on every
table, and the application role holds no DELETE.

- `security.alerts`: one row per alert. Columns: `id` (UUIDv7), `rule` (a code of the
  catalogue), `severity` (`s1`-`s4`), `state` (`open`, `acknowledged`, `resolved`), `key_type`
  (`account`, `ip`, `market`) and `key_value` (at most 64), `event_count`, `first_event_at`,
  `last_event_at`, `opened_at`, `notify_step` (>= 0), `next_notify_at` (null when nothing is
  due), `acknowledged_at` and `acknowledged_by`, `resolved_at`, `resolved_by`, `resolution`
  (`contained`, `false-positive`, `duplicate`, `accepted-risk`), `resolution_note` (10 to 1000
  characters), `version`.
  - `alerts_state_columns_check` ties each state to its columns (an open alert has no
    acknowledgement or resolution; a resolved one has all four resolution columns and nothing
    due).
  - Partial unique index `alerts_market_id_rule_key_type_key_value_live_key`
    on `(market_id, rule, key_type, key_value)`
    where `state <> 'resolved'`: one live alert per rule and key, also under racing evaluator
    runs.
  - Trigger `alerts_guard_update`: a resolved alert never changes; the identity columns (id,
    Market, tenant, rule, severity, key, `opened_at`, `first_event_at`) never change; an
    acknowledged alert never reopens; an acknowledgement is never rewritten or cleared;
    `event_count`, `last_event_at` and `notify_step` never go back; every update adds exactly
    one to `version`.
  - Indexes: `(market_id, state, severity, opened_at desc)` for the list, `(market_id,
    next_notify_at)` for the delivery job, `(market_id, rule, key_type, key_value, resolved_at)`
    for the evaluator's look-ups.
- `security.alert_deliveries`: the timeline of an alert, insert-only. One row per message:
  `alert_id` (FK on `(market_id, alert_id)`), `step` (>= 1), `recipient` (a roster code, or
  `roster` when no roster is configured), `channel` (`email`, `sms`, `call`, `team-chat`),
  `outcome` (`sent`, `failed`, `not-configured`, `no-contact`), `at`. No address, phone number
  or message text is stored.
- `security.digest_runs`: one row per Market, kind (`daily`, `weekly`) and period (`YYYY-MM-DD`
  or `YYYY-Www` in the roster's zone), insert-only; its key makes a digest go out once.
- `security.evaluator_runs`: one row per Market with the end of the last evaluator run and how
  many alerts it opened (the "rules last ran" line of the summary).

Personal data: `alerts.key_value` holds an account id or an IP address for `account` and `ip`
keys, and `acknowledged_by` and `resolved_by` are account ids. They are PII under the privacy
review (INTL-52); the list masks an address key and messages carry neither.

Retention is deferred: alerts are deduplicated per rule and key and deliveries are bounded by
the escalation steps, so growth is small. It becomes necessary at about one million delivery
rows or at the INTL-52 privacy review, whichever comes first. It will need its own migration,
because the DELETE and TRUNCATE triggers and the missing DELETE grant block it today; the
archive pattern of `platform.security_events` (platform.md 13) is the model.

Grants to `mondapac_app`: USAGE on the schema; `alerts` SELECT, INSERT and UPDATE of the state,
count, delivery and resolution columns and `version` only; `alert_deliveries` and `digest_runs`
SELECT, INSERT; `evaluator_runs` SELECT, INSERT, UPDATE of `finished_at` and `opened`. The
expected privileges are checked in `apps/api/test/db/expected-privileges.ts`.

## 3. The security event feed

`platform/security-events/security-event-feed.ts` is the read port over
`platform.security_events`; `PersistenceModule.securityEventFeedFor('security')` binds it for
the security module only. It reads through `auditTx`, in the caller's unit, scoped by the
Market. Three reads: `groups` (count, first and last instant per account, per address or for
the whole Market, with a minimum count), `events` (ids, targets and instants, oldest first) and
`count` (for one key). The adapter refuses a query outside the catalogue's shape (types, a
non-empty window, at most two payload equality fields with code values, limit at most 500):
that is a programming error, never user input. Reads use the `(market_id, type, occurred_at)`
index of package 1.

## 4. Jobs

### 4.1 Evaluator (`security.evaluate-rules`, every minute, per Market)

For each rule of `domain/rules.ts`, in its own unit: read the matches in the rule's window
(at most 200 per rule), then for each match either raise the live alert's count and last event,
or open a new alert. After a resolved alert, a key opens a new alert only for events after the
resolution. A failing rule is logged by code and error name only and the others still run. Rule
kinds: `threshold` (N events in a window, grouped by account, address or Market), `each` (one
alert per event) and `success-after-failures` (a success after N failures of the same account).

### 4.2 Delivery (`security.deliver-alerts`, every minute; `security.send-digests`, hourly)

`domain/delivery.ts` plans each step from the severity (T4):

- s1: SMS, call and email to one more person of the escalation chain (the rotation from the
  member on call, then the incident commander) every 10 minutes until acknowledged, at most 12
  steps, at any hour.
- s2: email and team chat once to the member on call and the security owner, in business hours;
  out of hours it is held until the next business start.
- s3 and s4: nothing pushed; a daily (s3) and weekly (s4) digest by email to the security owner
  in business hours.

A step is claimed with a conditional update on `version` before anything is sent, so two runs
never send the same step. Each message is recorded in `alert_deliveries`. Channels without an
adapter (SMS, call, team chat today) are recorded as `not-configured`; email goes through the
platform mail transport. Messages carry the rule, severity, counts, instants and alert id only.

## 5. The on-call roster

A JSON file outside the repository, named by `SECURITY_ON_CALL_FILE`
(`config/security/on-call.example.json` shows the shape): business hours (IANA zone, start and
end minute, weekdays), members (code, name, account id, email, phone), the weekly rotation and
its start as a local date-time, the incident commander and the security owner (T7). The rotation
and the handover follow the zone's wall clock across daylight saving. Without a roster nothing
is delivered (each step records `not-configured`) and no one can resolve an s1 alert.

## 6. Responding

Only `security.alerts.respond` acknowledges or resolves, from an administrator session that is
not acting as a seller, with the expected version. An s1 alert is resolved only by the incident
commander or the security owner (D2). Each transition writes an audit entry
(`security.alert.acknowledged`, `security.alert.resolved`) with codes and integers only; the
note stays on the alert. Viewing needs `security.centre.view`; the list masks an address key.
