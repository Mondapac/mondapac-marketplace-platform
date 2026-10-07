# ADR-0025: Read-Only Units Without a Transaction, and Isolation as a Deployment Fact

**Status:** Accepted — 2026-10-07 (CTO), on Hassan's (security-tester) review of 2026-10-07
(accept option A with conditions), after Mohammad (software-architect) and Mojtaba
(database-designer) reviewed identity spike 6. Decision 1 holds only while the conditions below
hold: if slice 1a cannot meet conditions (a) to (e) (in particular (b), typed and at run time),
decision 1 returns to Proposed, read-only units open a transaction as before (with no
`SET TRANSACTION`; decision 2 is unaffected) and P 3.1 row 9 reverts. A revert is recorded here as
a dated status line. No owner decision is changed, so none is asked; the owner is
informed in the Phase 2 status summary.
**Amends:** ADR-0004 decision 5 and ADR-0023 decision 1 (the sentence "Read-only work still runs
in a transaction … (PA5)")
**Relates to:** ADR-0014 decision 6, ADR-0018 decision 2,
`docs/design/domain/platform-persistence-and-events.md` (P 3.1 rows 6 and 9, 3.3, 3.4 row 2,
13, 15, 16(a) PA5), `docs/design/domain/identity.md` (D 6.2, 12.3 row 6),
`docs/design/data/identity.md` (10, 11.4), `docs/design/data/platform.md` (10.7 to 10.9)

## Context
ADR-0004 decision 5, as amended by ADR-0023 decision 1, runs read-only work in a transaction.
PA5 kept that and deferred the question to identity spike 6. Spike 6 (2026-10-07, PostgreSQL
16.15, Prisma 7.10 with adapter-pg, seeded volumes; report in the shared folder
`phase-2/spikes/spike6/`) found:
- Every read of the access gate is an index probe (0.1 to 0.2 ms in the database).
- Under load the Node process is the limit: about 2.0 ms of CPU per request and about 600
  requests per second per process with a pool of 10.
- Of that, `SET TRANSACTION` costs about 0.6 ms, and the transaction itself about 0.5 ms more
  (measured with the `relationJoins` preview on).
- Under READ COMMITTED every statement takes its own snapshot, inside a transaction or not, so
  a read-only transaction gives no consistency that single statements lack.

## Decision
1. **A unit with `readOnly: true` opens no transaction.** `run` opens the store with the
   Market, the read-only flag and the guarded client, and runs `work` once.
   - The market guard applies unchanged and refuses every write; the platform writers refuse to
     run. The Market must be minted; a nested unit throws `NestedUnitOfWorkError`.
   - `timeoutMs` and `isolation` are refused together with `readOnly`. There is no retry.
   - Each statement is bounded by the login role's `statement_timeout`, and acquiring a pooled
     connection by the pool's connection timeout.
   - No security decision relies on one snapshot across statements: revocation, suspension and
     ownership are re-checked in the body's read-write unit. A read that needs one snapshot
     across statements needs a new option with its own design and review.

   Conditions (Ali and Hassan), proven in slice 1a before the path is used:
   - (a) with no open store, or a closed one, the guard fails closed: the store gets a `closed`
     flag in `run`'s `finally`, so a query awaited after `run` returns is refused;
   - (b) `MarketTransaction` exposes model delegates only (no `$transaction`, `$queryRaw`,
     `$executeRaw` or other `$` methods), by type (`tsc`) and at run time: in a read-only unit
     `tx(market)` returns a frozen object or proxy with model delegates only;
   - (c) `readOnly` with `timeoutMs` or `isolation` is refused;
   - (d) a nested unit throws;
   - (e) `test:db` cases: a write refused in a read-only unit, a read refused for the other
     Market, no transaction opened, and pool exhaustion failing fast (the adapter sets a
     connection timeout and an explicit maximum).
2. **READ COMMITTED is a deployment fact.** `run` passes no `isolationLevel` for it;
   `isolation: 'serializable'` still passes `isolationLevel: Serializable`. `DatabaseProbe`,
   run as the API login role, refuses to start unless `SHOW default_transaction_isolation` is
   `read committed`. A `test:db` case asserts the level inside a default unit as the application
   role. No login role and no database sets `default_transaction_isolation` or
   `default_transaction_read_only`.
3. **The Prisma `relationJoins` preview is not adopted** (ADR-0014 decision 6). It is revisited
   when a deployed environment measures the gate's p95 above 15 ms at expected load, or when the
   feature becomes generally available. Adopting it then needs an ADR-0014 amendment, Mojtaba's
   plan review of every gate query, and a guard test showing that `relationLoadStrategy` does
   not affect the guard.

## Consequences
- The gate and other read-only units save two round trips and a pinned connection. Spike 6
  measured about 750 requests per second per process with no `SET TRANSACTION` (decision 2), and
  about 1,490 with no transaction as well, but only together with `relationJoins`, which decision
  3 does not adopt; the gain of decision 1 alone is estimated, not measured. A read-only unit has
  no unit timeout, only the 30 s statement bound; an application-level deadline for the gate may
  follow.
- Statements of one read-only unit may run on different pooled connections. Nothing may rely on
  session state or on one snapshot. A once-a-minute `lastSeenAt` write runs in its own short
  read-write unit, never in the read-only gate unit.
- Forward constraints (Hassan): (i) if row-level security driven by a per-transaction setting is
  ever adopted, read-only units return to transactions or carry the setting on every statement;
  session-level `SET` or `set_config(…, false)` on pooled connections is forbidden everywhere;
  (ii) no login role and no database sets `default_transaction_isolation` or
  `default_transaction_read_only` (the role test of data platform.md 10.4 asserts that
  `pg_db_role_setting` has no entry for either key and that `default_transaction_read_only` is
  `off`);
  (iii) the `test:db` role-settings check runs as the login role outside a transaction.
- Kazem sizes the pool with per-statement connections in mind. Mojtaba sees no plan change.
- A wrong database or role default stops the API at boot instead of silently weakening every
  unit.
- Changes to the guard path and the UnitOfWork go through security-tester review before merge
  (identity is P0).

## Alternatives considered
- Keep the transaction (PA5 as written): about 0.5 ms of CPU per request for no consistency.
- Exempt only `Authenticator` and `AuthorisationCheck`: two kinds of read-only unit with no
  semantic difference.
- A transaction with `SET TRANSACTION READ ONLY`: adds cost.
- A named raw prepared statement for the gate: generic plans skip partial indexes (3.2 ms against
  0.05 ms, data platform.md 10.9).
