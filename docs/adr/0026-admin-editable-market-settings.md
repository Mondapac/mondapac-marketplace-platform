# ADR-0026: Admin-Editable Market Settings

**Status:** Accepted — 2026-10-07 (owner decision). Drafted by Mohammad (software-architect);
reviewed by Ali (cto) and Hassan (security-tester), fixes applied 2026-10-07. Mojtaba
(database-designer) designs the tables. Needed before the earliest of: `sellers` slice 15; `catalog`'s CAT-36, OFR-01 and OFR-03 setting slices; the
first `platform/ai` slice that checks a switch (ADR-0019 decision 7). The store lands no later
than that slice.
**Amends:** ADR-0003 decision 5; ADR-0015 decision 3 (pulls the row "Market configuration seeded
to the database", for editable settings only)
**Relates to:** ADR-0004 decision 7, ADR-0009 decision 2, ADR-0012, ADR-0018 decisions 3 to 5,
ADR-0019 decision 7 and R7/R8, ADR-0025; `docs/design/domain/identity.md` 8.5,
`docs/design/domain/sellers.md` 4.1, 6.1, 7.6, 14.1; board requests 8 item 3, 11 item 4, 15 item 3

## Context
ADR-0003 decision 5 makes Market configuration code, so a change needs a release. These values
must change at run time; `identity` reads "approval required" without importing `sellers`
(identity R7), and `identity`'s G2 asks for a platform store, synchronous reads that see a
committed change at once, and an audited change.

| Need | Source | Owner |
|---|---|---|
| Approval required; read by `identity` and `sellers` | SEL-15, SEL-03, AC 19 | `sellers` |
| Approval Required | CAT-36 | `catalog` |
| Seller can create product; sell from catalogue | OFR-01, OFR-03 | `catalog` |
| AI off per capability, or all AI, per Market, without a release; an error means off | ADR-0019 R8, decision 7 | `platform/ai` |
| Payout-link waiting period, an admin setting per Market | VER-10 (Phase 5) | Owner of VER-10 |

## Decision
1. **One platform store, owned values.** Editable settings live in a platform store
   (`platform/market-config/`, `platform` schema) keyed by `market_id`, `tenant_id` and code.
   The owning module declares each setting in its `contracts/` and registers it at boot, like
   permissions: code, type and bounds, default path in `config/markets/`, safe value
   (decision 5), view and edit keys, and reader list. `platform/` imports no module.
2. **Reading.** A module reads through its own policy port, whose adapter names the setting code
   as a literal (e.g. `identity`'s `IdentityMarketPolicy` names "approval required"; it never
   imports `sellers`). At boot the registry checks that every code a port names is declared and
   that the reading module is on its reader list; otherwise boot fails. A read is a query in the
   caller's unit (ADR-0025); no cache, so the next unit in any process sees a committed change.
   A decision that must match the value reads it in its own read-write unit.
3. **Changing.** A change is a use case of the owning module (`platform/ai` for the AI
   switches), with `ActorContext`, `MarketContext` and the setting's edit key, refused in an
   acting-as session. In one unit it validates against the declaration, checks the expected
   version (a stale edit is refused), writes the current value and an append-only history row
   (who, when, before, after; ADR-0009 V4), one audit row `<module>.market-settings.changed`
   (`platform.ai.market-settings.changed` for AI), and `platform.market-setting.changed.v1` in
   the outbox (Market, code, version; no actor, no value). An admin belongs to one Market
   (ADR-0018 decision 3), so a change never crosses Markets; tests show it on AU and ZZ.
4. **Seeding.** At boot, for each hosted Market and declared setting, a missing row is inserted
   with the checked-in default, writing history and audit rows as the system actor; boot raises
   an alert when it inserts a row for a Market that already has other rows. An existing row is
   never overwritten: after seeding the store is the source of truth; boot logs a difference
   from the checked-in value. `mondapac_api` has no DELETE grant on the settings tables, and on the history table only INSERT
   and SELECT (UPDATE only on the current-value table); a `test:db` test asserts UPDATE and DELETE
   on the history table are refused.
5. **Fail mode.** On a missing row or a read failure the reader returns the setting's safe value,
   which is restrictive and declared in the owning module's code, never in `config/markets/`, so
   Market configuration cannot weaken it. It logs an error and raises an alert and a metric; it
   never falls back to another Market. Safe values: approval required (SEL-15) on, CAT-36 on,
   OFR-01 and OFR-03 off, AI off, VER-10 waiting period its upper bound. Hassan reviews each.
6. **Effective dating.** A change takes effect at commit, forward only; no future-dated change.
   Where an old value must keep governing a record, the aggregate stores the value it used (as
   `sellers` stores `approvalRequiredAtRegistration`; the stricter wins). VER-09 rates and dated
   configuration (commission, tax, ServiceArea activation, prices) are V2 records of their
   owning modules, not settings.
7. **Permissions.** Each edit key is declared by its owning module and protected (R11) where its
   G2 says so; `sellers.market-settings.edit`, the AI Market switch key and the VER-10 key are
   protected, and the VER-10 declaration has a hard minimum. The admin second factor applies
   (ADR-0018 decision 5). No source asks for a two-person rule, so none is added.
8. **AI break-glass.** `AI_KILL_SWITCH` (one per Region Stack, named by Kazem) forces all
   AI off, never on. Allowed values `true` or `false`, unset means `false`; any other value fails
   boot (`InvalidConfigError`), so a typo never leaves AI running. The `platform/ai` slice adds it
   to the config schema and `.env.example`. `platform/ai` checks it before reading the
   store; it takes effect on restart, which counts as without a release (R8); boot warns while
   it is set. The runbook and the R8 pre-switch-on test include it.
9. **Never a setting.** Anything read by `evaluateClaim` or `ClaimBasisPolicy` (ADR-0012,
   fail-closed); `identity`'s security policy (including "email verification required"); AI
   provider, model and region (R7); payment and commission values; `HOSTED_MARKETS`. Moving
   anything off this list needs a superseding ADR and security-tester review; every new
   editable setting needs security-tester review and is otherwise a G2 or mini-review item of
   its owning module. Per-seller settings (SEL-25) stay in `sellers`.
10. **Telling senior admins** (sellers brief; the owner said yes). `identity` subscribes to
    `platform.market-setting.changed.v1` and, for protected settings only (read from the
    platform registry), mails the holders of the admin system role of that Market; the mail
    names what changed and points to the audit log, never a value.
    Owner decision: yes (2026-10-07).

## Consequences
- `identity` and `sellers` keep their ports; only adapters change. No module imports another
  to read a shared value.
- R8 is met from the panel and by break-glass; a failing store gives the restrictive value and
  an alert.
- Platform gains one store with history, one event and a seeding step; Mojtaba designs the
  schema; Hassan reviews the reader, writer, seeding and every edit key.
- A checked-in change to an editable default no longer changes a live Market.
- Follow-ups: `sellers` 14.1 ("fail closed to the configured value") needs a `sellers`
  mini-review recorded in its change log; on acceptance, "Amended by ADR-0026" lines go into
  ADR-0003 and ADR-0015, and platform-foundations row 8 is marked pulled.

## Alternatives considered
- **Each module stores its own settings:** `identity` would import `sellers` or keep a copy;
  the AI Market switch has no module.
- **Configuration as code only:** fails R8 and SEL-15.
- **Hosted feature-flag service or Redis as the store:** new vendor and residency question;
  Redis is never a source of truth (ADR-0004).
- **Effective-dated (V2) settings throughout:** no source needs a future-dated switch.
