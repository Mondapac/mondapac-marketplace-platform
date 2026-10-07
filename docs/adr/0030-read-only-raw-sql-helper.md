# ADR-0030: Read-Only Raw SQL Helper with a Checked-In Statement List

**Status:** Accepted — 2026-10-07 (CTO; within CTO authority as for ADR-0025), on the reviews of Hassan (security-tester) and Mojtaba (database-designer) below; the CODEOWNERS entry of decision 2 merges with this acceptance (`.github/CODEOWNERS`). Conditions C1 to C4 are met in `certification` slice 1 before S1 to S3 merge. Drafted by Mohammad (software-architect) on Ali's (cto)
decision O1 (option A, `docs/design/data/certification.md` 7.2) and his conditions for the list;
reviewed 2026-10-07 (see Reviews). Must be Accepted before `certification` slice 1 merges (its
slice plan lists it as a dependency, CD 14), and before any later slice that adds a raw
statement. The CODEOWNERS PR of decision 2 merges before or together with acceptance.
**Amends:** ADR-0025 decision 1, condition (b) (read-only units expose model delegates only, so
raw SQL is refused). The amended ADR is not edited until this one is Accepted.
**Relates to:** ADR-0004 decisions 3 and 5, ADR-0008 decision 6, ADR-0012 decision 5, ADR-0028
decision 1, `docs/design/domain/platform-persistence-and-events.md` (P 4.2 "Raw SQL", 12.2 rule
4), `docs/design/data/platform.md` (10.2, 10.9), `docs/design/domain/certification.md` (CD 4.2
steps 2, 3 and 6), `docs/design/data/certification.md` (7.2, 7.3), `docs/design/data/catalog.md`
(6.3, Q-K8), `docs/design/domain/catalog.md` (16.2, 17.1 item 7)

## Context
All data access goes through Prisma, and the market guard (P 4.2) refuses raw SQL inside a unit
because it cannot read SQL. ADR-0025 condition (b) made that structural for read-only units:
`MarketTransaction` exposes model delegates only, by type and at run time.

`evaluateClaims` (CD 4.2) must decide each basis from **one statement**: read-only units open no
transaction (ADR-0025), so under READ COMMITTED each statement is its own snapshot, and a basis
read in several statements could combine rows from different moments. Prisma's default `include`
sends one query per relation level; `relationLoadStrategy: 'join'` depends on a preview ADR-0025
decision 3 did not adopt, and whether it yields one statement for these shapes is unmeasured and
could change with a Prisma upgrade. Ali chose option A on 2026-10-07: three raw `SELECT`
statements (S1 seller basis, S2 type and policy, S3 manufacturer basis; data design 7.3) through
one platform helper. P 4.2 already foresaw this: "named statements on a checked-in list, the
Market bound by the helper as the first parameter, each proven by a two-Market database test".

`catalog` checked every raw candidate (subtree, rescan, reconciliation cursor, M1 marking) and
needs none (data catalog 6.3). Its cycle trigger is migration SQL, ruled outside this ADR
(Q-K8). No other module has asked for one.

## Decision
1. **One port, read-only.** The platform offers one port, `RawReadPort`, in
   `platform/persistence/`. It is separate from `MarketTransaction`, which stays model delegates
   only (ADR-0025 (b) unchanged for it). Its one method takes a statement id and the statement's
   parameters; it never takes SQL text, a fragment, an identifier or an `Unsafe` form. It returns
   rows parsed by the statement's result schema; a row that fails the schema fails the whole call
   closed (for `evaluateClaims`, `unavailable`, CD 4.2 rule 1).
2. **One checked-in list.** Every raw statement is an entry in a single file,
   `apps/api/src/platform/persistence/raw-reads/statements.ts`. An entry holds: a stable id
   (`<module>.<name>`, e.g. `certification.seller-basis`), the **owning module**, the reason
   Prisma does not suffice, the design section that specifies it, the SQL text as a static
   constant, and each parameter's name, PostgreSQL type and, for an array, its length cap (arrays
   zipped by one `unnest` are declared as a group and must have equal lengths).
   A change to the file needs the sign-off of Ali, Hassan and Mojtaba, recorded in the PR, and
   Mojtaba's plan review of the changed statement. CODEOWNERS names the owner's GitHub account
   (`falahjoon-prog`) for the list, the helper, the boundary script and its fixtures, and the ESLint
   rule of decision 6. The entry comes in its own shared-file PR, announced on the board, that
   merges before or together with this ADR's acceptance (Ali's ruling b).
3. **Own schema only.** Each statement reads only tables of its owning module's schema, every
   relation schema-qualified (`"certification"."issuers"`) and each one a table of the owner's
   Prisma models (as `scripts/prisma-schema.mjs` reads them), so a view, another module's schema,
   `public` or a system catalog fails. No user-defined function and no view: the only functions
   allowed are on an allow-list in the check, today `unnest` over bound parameters (optionally
   written `pg_catalog.unnest`); any other call, a set-returning function in `FROM` included,
   fails the check closed. It may be called only from `modules/<owner>/infrastructure/`. A read
   that needs another module's data still goes through that module's facade (ADR-0008 decision
   5), outside the statement, as CD 4.2 step 1 reads seller zones from `sellers`.
4. **Read-only.** The text is one statement, starting with `SELECT` or `WITH`; no
   data-modifying CTE, no `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `COPY`, DDL,
   `CALL`, `DO`, `SET`, `SELECT … INTO` or locking clause (`FOR UPDATE`, `FOR SHARE` and their
   variants); the function allow-list of decision 3 already excludes `nextval`, `set_config` and
   `pg_advisory_*`. A row lock needs its own design and ADR. The controls are the parse check of
   decision 6 and the `BEGIN READ ONLY` case of decision 9. At boot the helper also re-checks
   every entry with the same pure parse, with no database round trip (never `PREPARE` or
   `EXPLAIN ANALYZE`), and refuses to start on a violation. Writes, bulk writes included
   (catalog's M1 marking, for example), stay in Prisma, through `MarketTransaction` in a
   read-write unit.
5. **Bound parameters; the Market from the unit.** Two kinds of value: every value that comes
   from a caller is a bind parameter, and the helper never builds SQL from strings; fixed literals
   in the stored text (`c.status NOT IN ('declined', 'revoked')`) are allowed, because partial
   indexes are used only when the predicate is a literal (platform.md 10.9). `$1` is `market_id`,
   required in every statement, bound by the helper from the open unit's `MarketContext`, never
   by the caller. The Market rule (Hassan C2): for every relation, `<alias>.market_id = $1` is a
   top-level `AND` term of that relation's own `ON` clause, or of `WHERE` for the `FROM` root,
   never inside an `OR`; it applies inside every subquery and CTE; `market_id` is never compared
   to a literal; an aliased `unnest` is exempt by name. The helper checks the parameter count and
   types, refuses an array above its cap and zipped arrays of unequal length. The helper sends
   through the same Prisma adapter as every other query, unnamed (platform.md 10.9): no
   `statementNameGenerator`, never a raw `pg` client with a statement name.
6. **One boundary check in `pnpm boundaries`.** `scripts/check-prisma-boundaries.mjs` gains one
   check, `raw-read-statements`, that fails when:
   - a call to `RawReadPort` passes anything but a string literal id present in the list, or is
     made outside `modules/<owner>/infrastructure/` of that entry's owner;
   - a statement text does not parse as SQL (the check fails closed on what it cannot parse; a
     regular expression is not a parse), breaks decision 4's text rule, names a relation that is
     unqualified or not a table of the owner's Prisma models, calls a function off the allow-list
     of decision 3, or breaks the Market rule of decision 5;
   - anywhere under `apps/api/src` (Hassan C3), outside the helper and the platform files named in
     the check (today `DatabaseProbe`; the relay claim and the scheduler lock when they land,
     P 4.2): `$queryRaw`, `$executeRaw`, their `Unsafe` forms or `$queryRawTyped`, in any form
     (`client['$queryRaw']`, destructuring), `Prisma.sql`, `Prisma.raw` or `$extends`; and any
     import of `pg` outside `platform/persistence/prisma-root.ts`.
   The existing ESLint rule `no-raw-sql-or-transaction-in-modules` (P 12.2 rule 4) stays.
   Fixtures in `apps/api/test/boundary-fixtures/` cover each failure and one passing call.
7. **Runs on the ADR-0025 read path only.** The helper runs only inside an open read-only unit,
   on the unit's pool with no transaction, as ADR-0025 decision 1 sets for model reads. It fails
   closed with no open store, a closed store (condition (a)) or a read-write unit: inside a
   transaction it would run on another connection and outside that unit's snapshot and
   isolation (upheld by Ali, ruling a). A raw read inside a read-write unit needs a new ADR.
   Each call is bounded by the
   login role's `statement_timeout`; there is no retry.
8. **Logging without values.** The helper logs the statement id, owning module, Market,
   correlation id, row count, duration and, on error, the SQLSTATE. It never logs parameter
   values, SQL with values or result rows; a driver error is rethrown with that data and without
   the original message, which may quote values. A result-schema failure logs the statement id
   only, never the validation details. Prisma query-event logging is forbidden outside
   development.
9. **Tests.** Per statement, in `test:db`: a case run in both Market fixtures (AU and the
   synthetic ZZ: AU rows never answer a ZZ call and the reverse); an assertion that one call
   issues exactly one SQL statement and no `BEGIN`; a run inside `BEGIN READ ONLY` as the
   application role (Hassan C1: catches a data-modifying CTE, `FOR UPDATE` and `nextval`); and
   the catalog check (Mojtaba): `EXPLAIN (GENERIC_PLAN)` (PostgreSQL 16+) of the text, with every
   relation it reads having `relkind IN ('r', 'p')`. For the helper: unknown id, an over-cap
   array, unequal zipped arrays, a caller-supplied Market, a read-write unit and a closed or
   missing store are refused; a list entry that writes, locks, calls a function off the
   allow-list or reads another schema stops the boot; a log assertion finds no parameter value.
   The boundary check's fixtures of decision 6 run under `pnpm test`. The controls of C1 to C4
   are in place in `certification` slice 1, before S1 to S3 merge.
10. **Out of scope.** SQL inside migrations, trigger and other function bodies included: it is
    reviewed under platform.md 10.2 and Ali's Q-K8 ruling (`SECURITY INVOKER`, no dynamic
    `EXECUTE`, fixed `search_path`, schema-qualified names). The platform's own raw statements on
    `PrismaRoot` (relay claim, scheduler lock, `DatabaseProbe`) stay under P 4.2, in transactions
    of their own; they are not list entries, and decision 6 names their files.

## Consequences
- `evaluateClaims` reads each basis in one statement whatever the Prisma version, and the plans
  reviewed in data certification 7.3 are the plans that run.
- First entries: S1 to S3 of `certification`, added in its slice 1. `catalog` adds none; if a
  later catalog slice needs one, it adds an entry under this ADR and its reviews before merge.
- ADR-0025 (b) now reads: `MarketTransaction` exposes model delegates only; a read-only unit may
  also reach `RawReadPort`, which runs only listed statements. On acceptance, ADR-0025 gets an
  "Amended by ADR-0030" line.
- The guard still cannot read SQL. Market isolation of a raw statement rests on the text check,
  the helper-bound `$1` and the two-Market test; a missing `market_id` predicate is caught by the
  check, not by the guard. Hassan's forward constraint on row-level security (ADR-0025) applies
  to these statements too.
- The grants do not help here: `mondapac_app` may `SELECT` every module schema and holds
  `INSERT`, `UPDATE` or `DELETE` on many tables (platform.md 10.2), so they enforce neither
  own-schema nor read-only. The parse check and the `test:db` cases are the controls.
- Each statement change costs a three-person review and a plan check; that is intended. Raw SQL
  stays rare, visible in one file and owned by one module.
- Schema renames in the owner's module must update the list in the same PR; the two-Market test
  and the boot check catch a missed one.

## Alternatives considered
- **Prisma with `relationLoadStrategy: 'join'` (option B):** no raw SQL, but one statement is
  not guaranteed, it needs the preview ADR-0025 decision 3 declined, and a version change can
  split it silently.
- **Statement text kept beside each caller in the module:** reads naturally, but scatters raw
  SQL, makes the review set harder to see and the CODEOWNERS rule harder to apply; Ali asked for
  one file.
- **Raw SQL on `MarketTransaction`:** reverses ADR-0025 (b) for every module and every unit, and
  the guard cannot check it.
- **A read-only transaction around the statements:** gives one snapshot for several statements
  but brings back the costs ADR-0025 removed, and is not needed when each basis is one statement.
- **SQL functions in the module schema:** moves the reads into migrations, where the plan and
  Market review happen less often, and adds `EXECUTE` grants (platform.md 10.2).

## Reviews
| Reviewer | Verdict | Date |
|---|---|---|
| Ali (cto) | Signed, with: function allow-list (decision 3), bound values versus fixed literals (decision 5), grants are not a control (Consequences); rulings (a) helper refused in read-write units, (b) CODEOWNERS PR before or with acceptance | 2026-10-07 |
| Hassan (security-tester) | Approved with conditions C1 (`BEGIN READ ONLY` case), C2 (Market rule), C3 (repository-wide raw-SQL check), C4 (CODEOWNERS and recorded sign-offs), and the logging conditions; C1 to C4 in place in `certification` slice 1 | 2026-10-07 |
| Mojtaba (database-designer) | Signed, with: same Prisma adapter, unnamed; boot check a pure parse; catalog check in `test:db` | 2026-10-07 |
