# ADR-0032: Audit-Chain Hardening (External Anchor) and Settle-Window Invariant

**Status:** Accepted - 2026-10-08 (CTO; the owner is informed in the Phase 2 status report), on the reviews of Hassan (security-tester) and Mojtaba (database-designer) of `docs/design/domain/platform-audit.md`.
**Amends:** ADR-0015 decision 3 (adds one row to the table of deferred items).
**Relates to:** ADR-0009 (V4, decisions 5 and 6), ADR-0015 decision 1, ADR-0016, ADR-0018, ADR-0023, ADR-0025, ADR-0029; `docs/design/domain/platform-audit.md` (7.2, 8); `docs/design/data/platform.md` 11.

## Context
The audit hash chain (identity slice 6) detects edits, gaps and backdated rows, but someone who owns the database can recompute the whole chain. Only a copy of the chain head kept outside the database's trust domain detects that. In Phase 2 the anchor is a log line that cannot be read back, which is acceptable only while no environment is deployed and all data is synthetic.
The sealer seals rows in time order behind a settle window S (5 minutes). This is correct only while no transaction that writes an audit row can live longer than S. That bound comes from the unit timeout and the statement timeout ceilings.

## Decision
1. **Release trigger for audit-chain hardening.** New row in the ADR-0015 decision 3 table: "Audit-chain hardening | Before any non-local environment, shared staging included, that holds non-synthetic data or is reachable by anyone outside the dev team." The set is: the external readable anchor of decision 2 (Object Lock bucket per Region Stack); a worker-only database group that alone may INSERT into `audit_log_seal` and `audit_chain_checkpoint` (the api role keeps SELECT only); chain-epoch recovery (operator command, tests and runbook; the `epoch` column and its place in the hash input exist from hash version 1); `transaction_timeout` on the database login roles (decision 3); the external operator log for SYSTEM operator commands; and the owner's answers on audit retention per Market and on who receives integrity alerts. Until the trigger the log anchor is allowed. ADR-0015 decision 2 is unchanged.
2. **Minimum anchor.** The bucket uses Object Lock in compliance mode, never governance mode, with retention at least the audit retention. The application credential can only put objects: it cannot delete, overwrite, bypass or shorten retention, or change the bucket policy, and it sits in a trust domain separate from the database owner and its operators. Every put is a conditional write (`If-None-Match: *`). The verifier reads every version of a key and treats differing versions as a mismatch. A staleness monitor outside the application alerts when a Market has had no anchor for more than 25 hours. After a retention drop, the verifier's starting checkpoint is checked against the anchor. The readable side (`AnchorSource`) is live before the environment opens. Kazem owns the bucket; Bagher checks the trigger at release.
3. **Settle-window invariant.** S >= 4 x (MAX_UNIT_TIMEOUT + STATEMENT_TIMEOUT_CEILING), asserted by a unit test that fails the build. No unit-timeout override, including for a batch job, may exceed the platform ceiling. Raising a ceiling needs a CTO decision and a change to S in the same change. From the trigger of decision 1, `transaction_timeout` on the database login roles enforces the bound on the database side as well, and the assertion uses it. Before then it is measured on PostgreSQL 17 that `SET LOCAL transaction_timeout = 0` inside an open transaction cancels the running timer, since the scheduler's job-lock transaction relies on it. The daily full verification is the backstop for backdated rows beyond the 24-hour late window.

## Consequences
- The residual window is the unanchored tail (up to 1 hour or 10 000 rows) plus the unsealed rows (S plus sealer lag). A row forged with the current time by a compromised application stays undetectable.
- QC rejects a release to an environment that meets the trigger of decision 1 unless every item of its set is in place, the anchor meeting decision 2.
- A longer-running audited transaction, for example a future batch job, must be split or come with a CTO decision that raises S.

## Alternatives considered
- Governance mode: an IAM permission can bypass it. Rejected.
- An HMAC chain under a stack secret instead of an anchor: a compromised application holds the key. Rejected (platform-audit.md 6.2).
- Seal order without a settle window (option B): backdated rows would be absorbed silently. Rejected (platform-audit.md 6.1).
