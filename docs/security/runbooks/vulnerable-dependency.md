# Runbook: vulnerable dependency

Part of [incident-response.md](../incident-response.md).

## Trigger and signals

- Dependabot alert or pull request (the `.github/dependabot.yml` file is planned in SOC package 4; until then use `pnpm audit` and the GitHub Security tab).
- Public advisory for a library, framework or container image we use.
- A supplier notice.

## Severity and deadlines

| Case | Severity | Fix deadline |
| --- | --- | --- |
| Known exploit or the vulnerable code is reachable in our app | S2 (S1 if data or payments are being attacked) | 24 hours |
| High severity, not known to be exploitable | S3 | 7 days |
| Medium or low | S4 | Next regular update |

Hassan sets the final severity after checking reachability. When unsure, treat as exploitable.

## Automatic actions

Automatic update pull requests from Dependabot (planned in SOC package 4). They are only proposals; a person reviews and merges, tests must pass, and no test is skipped to merge them.

## Human steps

1. Acknowledge and open a ticket with the advisory id, package, versions and deadline.
2. Assess: which app (`apps/api`, `apps/web`, `apps/admin`, `apps/seller`, packages), runtime or dev only, is the vulnerable function reachable, is it internet-facing, is there a known exploit.
3. Fix: upgrade to the patched version in a pull request (or Dependabot's). If no patched version exists, apply the advisory's workaround, remove the feature, or replace the library.
4. Run the full test suite and lint in CI; Hassan reviews S2 fixes. No workflow edits or skipped tests to speed it up.
5. Deploy. For an exploitable issue, deploy as soon as CI is green and watch logs.
6. If exploitation may already have happened, check logs and the audit trail for the exposure window and treat as an incident: [customer-data-breach.md](customer-data-breach.md), [leaked-secret.md](leaked-secret.md) as needed.
7. If the fix cannot meet the deadline, Hassan records a time-limited exception with a mitigation (disable the feature, edge rule once available) and a new date; Ali approves.

Emergency steps (for example disabling a feature or a switch) write an audit event with actor, reason and target.

## Verification

1. Lockfile shows the patched version; the advisory no longer appears in `pnpm audit` or GitHub.
2. Tests green; the affected feature checked manually.
3. No suspicious activity during the exposure window.

## Close-out

Close the ticket with dates (found, fixed, deployed). Keep a count of findings and time to fix for Hassan's weekly review. Actions: auto-merge rules for patch updates once tests are trusted, remove unused dependencies.
