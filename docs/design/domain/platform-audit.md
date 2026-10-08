# Platform audit: writer, hash chain, sealer (identity slice 6)

**Author:** Mohammad (software-architect), 2026-10-08
**Status:** Approved with conditions by Ali (2026-10-08); final ruling by Ali 2026-10-08: 6a may start when the conditions listed in 15 hold. Hassan OK with conditions (re-review 2026-10-08); Mojtaba OK, data design signed off 2026-10-08 (DP 11). Every condition is applied in this text or recorded as a trigger with its owner (section 18). Open: Q5 and Q7 for the owner (17).
**Updated:** 2026-10-08, three review rounds applied (section 18).
**Ground truth:** ADR-0004 decision 7; ADR-0009 V4 and decisions 5, 6 and 8; ADR-0015 decisions 1 to 3; ADR-0018 decisions 3 and 4; ADR-0020 decisions 1 and 8; ADR-0023; ADR-0025; ADR-0026 decision 3; ADR-0005; ADR-0006. Also `docs/design/data/platform.md` (2, 3.3 to 3.5, 5, 10, and 11, cited as "DP 11"), `docs/design/data/identity.md` 6 and 8.1, `docs/design/domain/identity.md` (5.5, 5.6, 10, 12), `docs/design/domain/platform-foundations.md` (3.4, 3.8, 5.2), `docs/design/domain/platform-persistence-and-events.md` ("P": 3.1, 3.3, 5.3, 7), the identity brief (AC 11, AC 12, AC 27, R5), and VER-08, VER-13, VER-14, IMP-06, IMP-10, CERT-32.
**Code on main checked:** `platform.audit_log` (baseline plus grants); `OutboxWriter` and its per-module binding; `JobRegistry`, `AdvisoryJobLock`; `SubjectKeyService` (`hmac` returns lowercase hex); `ActorContext` kinds `anonymous`, `system`, `authenticated`. No `platform/audit` code exists yet. Main carries identity migrations up to slice 2.

## 1. Scope
- **Decided here:**
  - the audit writer and its action catalogue (3, 4);
  - what identity audits, slice by slice (5);
  - the hash chain (6), the sealer (7), the verifier and the anchors (8);
  - failure behaviour and chain recovery (9), read access (10), retention and erasure (11), volume (12);
  - what Mojtaba's migration carries (13);
  - the 8a ordering question (14);
  - `ContentHash` (ADR-0020 decision 1, PF 3.8);
  - tests (16).
- **Not here:**
  - physical columns, types, indexes and SQL (Mojtaba, DP 11);
  - the admin audit screen (10);
  - SEL-08 acting-as (the column stays null; identity 4 row 6);
  - alert routing infrastructure (Phase 7, PK3).
- Everything is per Market. There are no country branches, and every time comes from the injected `Clock`.

## 2. Model and ownership
```
platform/audit            (platform infrastructure; imports no module)
  AuditActionCatalogue    actions registered by modules at boot, then sealed
  AuditWriter             bound per module; writes inside the caller's unit
  AuditSealer             worker job platform.audit-seal, per Market
  AuditVerifier           worker job platform.audit-verify, per Market; operator command
  AnchorSink (port)       external copy of chain checkpoints
platform schema (owner: platform; physical design: Mojtaba, DP 11)
  audit_log               existing, append-only; ANONYMOUS added to the actor CHECK
  audit_log_seal          new, append-only; one row per sealed audit row; the chain
  audit_chain_checkpoint  new, append-only; chain heads, also sent to the anchor
```
- **Boundaries.**
  - Modules reach the audit only through their own bound `AUDIT_WRITER` token, a pattern copied from `OUTBOX_WRITER`. No factory token exists, so no module can ask for another module's writer.
  - The Prisma code lives in `platform/persistence/audit/` (ADR-0015 decision 5).
  - No module reads `audit_log`, the seal table or the checkpoint table directly. Reading is section 10.
  - There are no events: nothing subscribes to audit, and an audit row is never a trigger for anything.

## 3. Writer

### 3.1 Contract
```ts
interface AuditWriter {               // platform/audit, bound per module
  record(context: CallContext, entry: AuditEntry): Promise<void>;
}
// built only through a definition: def.entry(targetId, { before?, after? })
```

| # | Rule |
|---|---|
| W1 | **Same unit as the change** (ADR-0004 decision 7, P 3.3). It calls `tx(context.market)` and never opens a unit. It refuses when no unit is open, when the unit is read-only, or when the context's Market is not the unit's Market. So an audited read (for example `sellers.business-details.viewed`) needs a short read-write unit for its row. |
| W2 | **Actor derived, never passed in.** `authenticated` becomes `USER` with `actor_id = accountId`. `system` becomes `SYSTEM`. `anonymous` becomes `ANONYMOUS`. `acting_as_id` stays null until SEL-08. The caller cannot supply any actor column (PF 5.2 rule 2). |
| W3 | **Stamped by the writer.** `id` comes from `IdGenerator` (UUIDv7). `market_id` and `tenant_id` come from the context. `correlation_id` comes from the context; it is always generated, never the caller's value (ADR-0020 decision 8). `occurred_at` is `Clock.now()` read at `record`, inside the unit, cut down to whole milliseconds. The database refuses any other value: CHECK `occurred_at = date_trunc('milliseconds', occurred_at, 'UTC')` (DP 11.2; Hassan M2). So the canonical form of 6.2 covers the full stored value. |
| W4 | **Declared shape only.** The action must belong to the bound module and be in the sealed catalogue. The actor kind must be in the action's `actors` list. `before` and `after` must match the declared fields exactly. A `listOf` value must not be longer than its declared maximum. The canonical JSON of `before` and of `after` must each be at most 4 KB, so the stored jsonb stays under the 8 KB database cap (13). A `permissionKey` value must be known to the registry or to its retired list, through the same `PermissionKeyLookup` the outbox uses; until 8a-1 that lookup is fail-closed. |
| W4a | **Anonymous rows name the bound subject** (Hassan M3). An action whose `actors` include `anonymous` must declare the `after` field `boundSubjectId` of kind `id`: the account or the invitation the credential binds. A definition without it fails at boot. The writer refuses an `ANONYMOUS` entry whose `boundSubjectId` is absent. This amends condition A3 of identity data 6: "the bound subject is named in `target_id` or in `after.boundSubjectId`" (edit listed in 15). |
| W5 | **A refusal throws** `AuditWriteRefusedError(reason, field?)`, which carries no values, so the unit rolls back. No audited change commits without its row. When the action fails, no row is written (AC 11). |
| W6 | **Several rows per use case are allowed.** One `record` call per audited action. The "exactly one row" of AC 11 is tested per action. |

Rejected alternative: writing audit through the outbox, with a consumer writing the row. Events carry no actor (ADR-0018 decision 4), delivery is at least once (so rows could be duplicated), and the row would be late. ADR-0004 decision 7 already decides against it.

### 3.2 No personal data, enforced mechanically
- `defineAuditAction` (kernel; declared in the module's `domain/`, re-exported from `contracts/`) takes:
  - `action` (`<module>.<subject>.<verb>`);
  - `targetType` (`<module>.<type>`);
  - `actors` (a non-empty subset of `authenticated`, `system`, `anonymous`);
  - optional `before` and `after` field maps.
- Field kinds come only from the closed payload vocabulary of P 5.3: `id`, `enumOf`, `boolean`, `integer`, `instant`, `permissionKey`, `listOf`, `optional`. No kind accepts free text.
- `listOf` takes a required maximum length in the definition (Hassan L3). A definition without one fails at boot.
- `targetId` is an `Id`, or a value of a declared `enumOf` (a natural key).
- `AuditActionCatalogue` works like `EventCatalogue`:
  - boot fails on a duplicate action or a foreign first segment;
  - a platform component binds its own writer under `platform.<component>.*`, and that prefix counts as its own first segment (for example `platform.ai.market-settings.changed`, ADR-0026; `platform.audit-log.viewed`, Q4; Ali);
  - it is sealed after boot, and the same in both roles;
  - a contracts test compares it with a checked-in snapshot, so Hassan reads every new action in the diff.
- `money` joins the vocabulary when `Money` lands (sellers 9 `minimum-order.changed`). The design of the vocabulary does not change for it.
- `anonymous` in `actors` is allowed only where the use case's credential binds exactly one account or invitation (data identity 6), and only with `boundSubjectId` (W4a). Hassan reviews each such action in the snapshot diff.
- **No free-text exception.** certification.md 11 no longer stores a change reason in an audit row: the reason stays on the revision and the row carries the revision id and `reasonGiven` (Q3, decided by Ali).

## 4. Actor and target
- `target_type` and `target_id` name the aggregate that changed: the account, the seller access record, the role, the invitation.
- `ANONYMOUS` rows name the bound account or invitation in `target_id` or in `after.boundSubjectId` (W4a; A3 as amended).
- `SYSTEM` rows identify the component by `action` and `correlation_id` (platform.md 3.2).

## 5. What identity audits (minimum; identity owns the final list in each slice PR)

| Slice | Use case | Action | Actor | before / after (allow-list) |
|---|---|---|---|---|
| 6b (retrofit of 5) | Seed of system roles, per hosted Market | `identity.role.seeded` | system | after `{scope, kind, seedVersion}` |
| 6b (retrofit of 5) | Seller Owner email verification for a self-registration: the unit that records `seller-registered` | `identity.seller-access.founded` (target: the seller access record); `identity.seller-member.added` (`founding: true`; target: the seller access record); `identity.account-role.assigned` (`founding: true`; target: the account) | anonymous (the link plus password bind the account) | Every `after` holds `sellerId`, `accountId` and `boundSubjectId` (= the account), plus: `{state, origin}`; `{roleId}`; `{roleId, scope}`. `sellerId` is required on `identity.account-role.assigned` in 6b; slice 7 reshapes it (optional, with a seller-scope rule in the use case) for platform-scope assignments (Mohammad, 6b review 11) |
| 7 | First-admin routine | `identity.invitation.issued` | system | after `{kind, roleId}` |
| 7 | Admin invitation acceptance, with the factor created inside it | `identity.invitation.accepted`, `identity.account-role.assigned` (founding), `identity.second-factor.activated` | anonymous | ids and state codes; `boundSubjectId` |
| 7 | Successful admin sign-in (identity 10.2) | `identity.admin-session.opened` | anonymous (target: the account) | after `{sessionId, boundSubjectId}` |
| 7 | Factor enrolment from a link; replace; regenerate codes; operator break-glass reset | `identity.second-factor.activated`, `.replaced`, `.recovery-codes-regenerated`, `.reset` | anonymous, authenticated, system | state codes; `boundSubjectId` on anonymous rows. The break-glass reset is `SYSTEM`; its accountability comes from the operator log of 9.2 (Hassan L6) |
| 8a-1 | Default-role seed applied; seed-version upgrade of system roles (an audited update, not `ON CONFLICT DO NOTHING`; Ali) | `identity.role.seed-applied` | system | `{seedVersion}`, `addedKeys`, `removedKeys` (`listOf(permissionKey)`, with a maximum) |
| 8a-2 / 8b | Assign an admin's role | `identity.account-role.assigned` | authenticated | before and after `{roleId}` |
| 8b | Admin invite, re-send, revoke; disable and re-enable; admin factor reset | `identity.invitation.issued`, `.reissued`, `.revoked`; `identity.account.disabled`, `.enabled`; `identity.second-factor.reset` | authenticated | state codes |
| 9 | Approve, reject, suspend, reinstate, re-apply; seller created by invitation | `identity.seller-access.approved`, `.rejected`, `.suspended`, `.reinstated`, `.reapplied`; `identity.invitation.issued` (`seller-owner`) | authenticated | `{state}`, `decisionId`, `basisId`; never the reason |
| 10 | Role create, edit, delete | `identity.role.created`, `.updated`, `.deleted` | authenticated | `addedKeys`, `removedKeys`; never the name (R5) |
| 11 | Staff invitation; member removed; role change | `identity.invitation.*`, `identity.seller-member.removed`, `identity.account-role.assigned` | authenticated or anonymous (acceptance) | ids; `boundSubjectId` on anonymous rows |
| 12 | Seller factor enable, disable, reset; owner confirms a reset by link | `identity.second-factor.*` | authenticated or anonymous | state codes; `boundSubjectId` on anonymous rows |

- **Sign-in outcomes.** Only a **successful admin** sign-in becomes an audit row. Every attempt, successful or not, goes to `identity.sign_in_records`, which has retention.
- **Founding rows** (Q1, decided by Ali 2026-10-08). They are written at verification, because the membership and the assignment take effect only then (`registered_at`, `seller-registered.v1`). The founding is still not a grant under R3; it is a change of access that must be traceable (AC 27, IMP-10). Conditions:
  - the actor is `ANONYMOUS` (identity 14.1-4);
  - each row targets the account or the seller access record, and `after` holds `sellerId` and `accountId` (and `boundSubjectId`, W4a), so a reader can follow the founding from the row alone;
  - **no backfill:** roles seeded and sellers verified before 6b get no row after the fact. A backdated row is exactly what the chain flags. Dev databases are reset instead.
- Unverified sign-ups write nothing, and the purge of unverified accounts writes nothing: those rows never took effect.

## 6. Hash chain

### 6.1 Toss-up: in what order rows are sealed (decided: A, Ali 2026-10-08)
| Option | For | Against |
|---|---|---|
| **A (decided). Settled order.** The sealer seals only rows with `occurred_at <= now - S`, in `(occurred_at, id)` order, behind a watermark. A row that turns up later below the watermark is sealed with `late = true` and raises an alert. | The chain order is meaningful (time order, as ADR-0009 V4 "seals rows, in order"). A backdated row (forgery, a wrong host clock, a bypassed writer) is detected rather than quietly absorbed. Reads are simple keyset queries with no anti-join on the hot path. | Correctness rests on a bound for how long a transaction can live, so S must be above it (7.2). Sealing lags by S. |
| B. Seal order. Every unsealed row is found by anti-join and sealed in the order it is found. | No time assumption. | A backdated insert is sealed silently. The anti-join needs a bounded window anyway (platform.md 3.5). |

### 6.2 Construction (hash version 1)
- `row_hash = SHA-256("MONDAPAC-AUDIT-ROW-v1" || 0x00 || canonicalRow)`.
- `chain_hash = SHA-256("MONDAPAC-AUDIT-CHAIN-v1" || 0x00 || uint16be(hash_version) || uint32be(epoch) || prev(32 bytes) || uint64be(chain_seq) || uint8(late) || row_hash)`. `hash_version` is bound into the chain, so a seal's version cannot be changed without breaking the link (Hassan L2). `epoch` is bound too, so a segment of one epoch cannot be spliced into another (Ali, 2026-10-08). The input after the tag is fixed length: 2 + 4 + 32 + 8 + 1 + 32 bytes.
- **Epoch from hash version 1.** `epoch` is NOT NULL and starts at 1. It is in the seal's primary key `(market_id, epoch, chain_seq)` and the checkpoint's key, from the 6a migration while the tables are empty (Mojtaba, DP 11). It is also in the seal's unique key `(market_id, epoch, audit_occurred_at, audit_log_id)` (DP 11.3, Mojtaba F13). Adding it later would mean changing the primary key of append-only tables and a hash version 2. Only the recovery of 9.1 ever opens epoch 2.
- **The current epoch is never read from the seals** (Mojtaba F12). It is the constant 1 until the epoch table of 9.1 exists, then that table's latest row for the Market. Otherwise one seal forged with a high `epoch` would move the sealer to that epoch. Seals in an epoch the epoch table does not know (any epoch above 1 while the table is empty) are a verifier finding, `audit.seal.unknown-epoch` (8).
- `prev` is the `chain_hash` of `chain_seq - 1` of the same Market and epoch. It is **not stored** on the seal (Mojtaba F4, accepted by Hassan): the sealer and the verifier read the predecessor. So where a chain starts must be stored and anchored: after a retention drop, the first retained link starts from the checkpoint's `chain_hash`, checked against the anchor (8).
- **Tenant.** A seal's `tenant_id` comes from the run's Market context; the sealer does not filter rows by tenant (one tenant value, ADR-0001). The row's own `tenantId` is inside its row hash (Mohammad, 6b review 10).
- Genesis: the `prev` of `chain_seq = 1` of epoch 1 is 32 zero bytes. A later epoch starts from a stored, anchored genesis link target (9.1). There is one chain per `market_id`; the Market is inside every row hash, so chains of different Markets never collide.
- `canonicalRow` is the UTF-8 bytes of `canonicalJson` (RFC 8785, JCS) of `{v:1, id, marketId, tenantId, occurredAt, actorType, actorId, actingAsId, action, targetType, targetId, before, after, correlationId}`, where:
  - `occurredAt` is RFC 3339 UTC with exactly 3 fractional digits and `Z` (the database guarantees nothing finer exists, W3);
  - an absent value is `null`.
- The sealer always hashes **what it reads back** from the database, never the in-memory copy. jsonb key order and number text then do not matter, because JCS re-canonicalises after parsing.
- **No row can stop the sealer** (Hassan M2). A row read back that `canonicalJson` refuses (for example a jsonb number beyond the double range, inserted outside the writer) is still sealed: its `row_hash` uses the fallback tag `"MONDAPAC-AUDIT-ROW-RAW-v1"` over `JSON.stringify` of the row as read, in the field order above. The sealer logs `audit.row.noncanonical` (Market, `chain_seq`, audit id). The verifier recomputes the same way and reports the same code. A row is never skipped and a batch is never thrown away because of one row.
- **The fallback is chosen only by whether `canonicalJson` refuses the row as read** (Hassan N1 c), never by a stored flag or by which hash matches. A row that canonicalises but carries a fallback-style `row_hash` is a mismatch.
- **The `audit.row.noncanonical` flag is mandatory** (Hassan I-b). The fallback writes a number beyond the double range as `null`, so two such rows can share a hash; this is acceptable only because every such row is flagged, by the sealer and by the verifier.
- Each seal row stores `hash_version`, so the algorithm can change later without rewriting history. A version change starts at an anchored checkpoint and never goes back; the verifier checks this (8).
- Rejected alternative: an HMAC chain under a stack secret. A compromised application holds that key anyway, it adds key rotation work, and nobody outside could verify without the key. External anchors (8) are what defend against rewriting.

### 6.3 `ContentHash` (decided here, as ADR-0020 decision 1 and PF 3.8 require)
- The kernel gets a branded string type: `ContentHash = "sha256:" + 64 lowercase hex | "hmac-sha256:" + 64 lowercase hex`, and `parseContentHash(string): Result<ContentHash, 'content-hash.malformed'>`.
- The kernel also gets `canonicalJson(value)`: pure TypeScript, RFC 8785. Number and string serialisation are exactly those of `JSON.stringify`, and keys are sorted by UTF-16 code unit. It refuses (Hassan I1):
  - non-finite numbers, `undefined`, `BigInt`;
  - anything but plain objects, arrays and primitives (`Date`, `Map`, `Set`, class instances, objects with `toJSON`);
  - cycles;
  - strings with a lone surrogate.
  It writes `-0` as `0`.
- In `platform/hashing/`: `sha256ContentHash(bytes)` (public content, such as catalog), and `hmacContentHash(hex)`, which wraps the output of `SubjectKeyService.hmac` (personal content: sellers, certification, ADR-0009 decision 6).
- The seal tables store hashes as 32-byte `bytea`; the `ContentHash` text form is used only at the boundaries: the anchor, the log line and the operator command (DP 11.3, F8).
- The "length 1 to 128" CHECKs in the data designs of sellers, certification and catalog become `^(sha256|hmac-sha256):[0-9a-f]{64}$`. This unblocks sellers slice 5 (sellers.md 2.4 rule 3). The kernel change is announced on the board (15).

## 7. Sealer (`platform.audit-seal`, worker only)

### 7.1 One run, per hosted Market
1. **Head.** Read-write unit, READ COMMITTED. Read the head (the seal with the highest `chain_seq` of the current epoch, which comes from code or the epoch table, never from the seals; 6.2, F12) and its predecessor, and recompute the head's `chain_hash`. If the link is broken, stop sealing this Market and alert `audit.chain.broken` (9). The sealer never repairs anything. The head is read again at the start of every batch, never carried over.
2. **Watermark.** The watermark is **the greatest sealed `(audit_occurred_at, audit_log_id)` of the Market** (in a later epoch: of that epoch, and never below its stored starting watermark, 9.1), read from the seal's unique key (DP 11.8; 4 buffers). It is never derived from the head (Hassan M1, Mojtaba F1): a late seal becomes the head with an older key, and a head-based watermark would go backwards. Non-late seals ascend in `(occurred_at, id)` and late seals are always below them, so this maximum is the key of the last non-late seal.
   - **A watermark later than `now - S` is an integrity finding** (Hassan N1 a). A seal can only be made for a settled row, so a later watermark means a forged row and seal (a future `occurred_at` with a correct chain hash). The sealer stops sealing this Market and alerts `audit.seal.watermark-future` (Market, `chain_seq`, audit id). It never seals behind such a watermark. Recovery is 9.1.
3. **Batch.** In the same unit: read up to 500 `audit_log` rows of this Market above the watermark with `occurred_at <= now - S`, ordered by `(occurred_at, id)`, in the keyset form of DP 11.8 (`now` is a `Clock` parameter, never SQL `now()`). Compute the hashes, give the rows `chain_seq` head + 1, head + 2, ..., insert the seals with `createMany`, and commit. Repeat until no rows are left or the run's time is spent.
4. **Late rows,** at most once every 5 minutes per Market, not on every tick, and always on the first sealer run after the worker starts, so frequent restarts cannot keep pushing it back (Mojtaba F3, decided by Ali 2026-10-08). A scan run twice by overlapping workers does no harm. The scan reads only below the watermark and the batch only above it, so they never interfere. Rows with `occurred_at` in `[watermark - 24 h, watermark]`, never below the current epoch's starting key (F10, 9.1), that have no seal (an anti-join through the seal relation, so no raw SQL). They are sealed in the next batch with `late = true`, and each raises `audit.seal.late-row`, logged with Market, `chain_seq` and audit id only. Older backdated rows are found by the daily full verification, check (d), which is the backstop (Ali Q2 condition 3; runbook, 15).
5. **Checkpoint, only when the head moved** (Mojtaba F2). When the batch moved the head and either 1 hour or 10 000 rows have passed since the last checkpoint, insert an `audit_chain_checkpoint` row `(market, chain_seq, chain_hash, hash_version, created_at)` in that batch's unit, at the new head. After commit, send it to `AnchorSink` (8). There is no checkpoint row without a new head.
6. **Heartbeat.** Once a day per Market the sealer sends the current head to `AnchorSink` as a heartbeat object (8), whether or not the head moved. It writes no checkpoint row. It sends none while the chain is empty or the Market's sealing is stopped (steps 1 and 2). The external staleness monitor (8) watches for it.
7. **Lag.** When the oldest settled row that is still unsealed is older than 15 minutes, alert `audit.seal.lagging`.
8. **Stalled.** When settled unsealed rows exist, on either side of the watermark, and the head has not moved for 3 consecutive runs, alert `audit.seal.stalled` (Hassan M1, N1 a). This catches a sealer that runs but cannot append. A run that stopped the Market (steps 1 and 2) never counts as progress, whatever head it read, so a forged head cannot reset the count. A run that throws counts as a run without progress and alerts `audit.seal.failed` (Market and epoch only), then rethrows (Hassan, 6b review M2). While a Market is stopped, "rows wait" is probed with one settled row above the watermark first and only then the late window (Mojtaba L1).
- **Duplicates are told apart** (Hassan M1). The conflict classifier reads the constraint name of the error, never guesses. `23505` on the seal's primary key `(market_id, epoch, chain_seq)` means another sealer won (7.2). `23505` on the unique key `(market_id, epoch, audit_occurred_at, audit_log_id)` means a selected row is already sealed in this epoch. The sealer then re-reads the head in a new unit: if the head moved, it lost a race; if not, it logs `audit.seal.duplicate-row` at error level (Market, audit id) and ends the run, which counts toward `audit.seal.stalled`. The `audit.seal.lost-race` info line names the SQLSTATE. A `23505` on the checkpoint's primary key (a checkpoint at a position no sealer reached) is the integrity alert `audit.checkpoint.conflict`; the batch rolls back and the run ends (Mojtaba L2).
- **Time range** (Hassan, 6b review M1; Mojtaba). Every read of the chain tables is bounded to `[2000-01-01T00:00:00Z, 10000-01-01T00:00:00Z)` on `audit_log.occurred_at`, the seal's `sealed_at` and `audit_occurred_at`, and the checkpoint's `created_at` (one constant, `AUDIT_TIME_RANGE`, the range of the CHECKs tracked as DP 11.15). A value outside (`infinity`, a year past 275760) cannot be read into a date and would otherwise stop the sealer; such rows are never sealed and the verifier names them by id (8 (j)). A seal or checkpoint outside the range is invisible to the sealer. A seal at the next position therefore ends every run as a 23505 on the primary key, which logs as a lost race, and the Market stalls: `audit.seal.stalled` within 3 runs, `audit.seal.out-of-range` from the verifier. Recovery is 9.1.
- **The sealer is platform infrastructure, like the relay.** It is not a use case and passes no gate. It runs with the scheduler's system `JobContext`. It goes through the guarded `tx(market)`, so the Market and tenant guard applies to every query, and it writes no audit rows itself.

### 7.2 Serialising appends without a global bottleneck
- **Writers never touch the chain**, so there is no contention on the business path (ADR-0009 V4).
- One chain per Market, so Markets are independent and a run that fails for AU still runs ZZ (P 7).
- Within a Market, linearity comes from the primary key `(market_id, epoch, chain_seq)` and the unique `(market_id, epoch, audit_occurred_at, audit_log_id)` (DP 11.3, F13; the same guarantee as a unique `audit_log_id`, Mojtaba F7, accepted by Hassan with the foreign key kept), not from the job lock, which is not a correctness control (P 7). Two overlapping sealers both read the same head; one commits.
- **Lost race** (Mojtaba F5). The loser gets `23505` on the primary key, or `55P03` (lock timeout) or `40P01` (deadlock). All three mean "another sealer won", unless the re-read head did not move (7.1 Time range): roll back, end this Market's run, log at info, never `audit.chain.broken`. The next tick continues from the new head. **No row locks:** the application role cannot `SELECT ... FOR UPDATE` or `FOR SHARE` on these tables (`42501`), and the design must not add one.
- **S, the settle window, is 5 minutes**, a platform constant. Today's ceilings bound a unit's life to about 60 s: a unit timeout of at most 30 s, plus one statement of at most 30 s that is still running when the timeout fires (P 3.1 row 8; `statement_timeout`, K1a). A retried attempt reads `Clock` again (W3). Host clock skew uses up the rest of the margin; skew beyond it shows up as late rows, which is a true finding. Conditions (Ali Q2):
  - a unit test asserts `S >= 4 × (MAX_UNIT_TIMEOUT + STATEMENT_TIMEOUT_CEILING)` and fails the build when it stops holding;
  - no unit-timeout override may exceed the platform ceiling, including for a future batch job. A higher timeout needs a CTO decision and a change to S (ADR-0032, 15);
  - the daily full verify, check (d), is the backstop for rows the 24-hour late window misses; the runbook says so.
- **Database-side bound** (Hassan L4). The unit timeout is enforced by the application; a blocked event loop can keep a transaction open with short statements and idle gaps. Before the hardening trigger (15), PostgreSQL 17 `transaction_timeout` is set on the login roles (with K1a) at or below `MAX_UNIT_TIMEOUT` plus a margin, the role-settings test (platform.md 10.4) checks it, and the S assertion uses it. Owner: Kazem with Mojtaba (15).
- **Replication** (Mojtaba F6). The bound assumes a commit is visible to other sessions once it returns. With synchronous replication (likely in Phase 7) a commit can stay invisible while it waits for the standby. A long stall then produces late rows that are false alarms. This is a runbook note for `audit.seal.late-row` and a note for Kazem's Phase 7 settings, not a design change.
- **Interval** every 10 s, `maxRunMs` 60 s. Capacity is about 50 rows/s sustained per Market (12).

## 8. Verifier and anchors
- **`platform.audit-verify`** runs every hour as an incremental check (from the last checkpoint) and once a day as a full check (from the earliest retained checkpoint). The schedule is per worker process and in memory: a process's first run for a Market is full, then a full run whenever that process has not completed one for the Market in 24 hours (a full run that failed or did not complete is retried full). The api image also gets an operator command `audit-verify --market <id> [--full]` (the pattern of identity 7.4). It exits 0 when clean, 2 with findings (also when the run did not complete: a finding wins, and the findings listed are valid), 3 when the verification did not complete and found nothing before it stopped (budget spent, or an error after start-up; stderr gets a fixed line with the error class and SQLSTATE, never a message), and 1 when refused (usage, an unhosted Market, a failed start) (Mohammad 8, Hassan L4). It reads in read-only units (ADR-0025), in batches; check (d) runs in time slices of one day that skip days without rows (DP 11.7; Hassan M3). A run stops at its budget (9 minutes for the job) with `audit.verify.incomplete` and reports nothing it did not check. Check (d) runs only after a complete walk, so an incomplete full run is retried full on the next tick.
- **Incremental start.** From the latest checkpoint at or below the pinned head; if that checkpoint does not match its seal, it is reported and the walk starts at the genesis. Check (d) then starts `LATE_SCAN_WINDOW` below the start seal, so a row the late scan could still seal is judged (Mohammad 5).
- **Pinned head** (Hassan L1). Read-only units have no shared snapshot, so the verifier reads the head `(chain_seq, chain_hash)` once at the start and verifies up to it, never past it.
- **It never trusts a stored hash.** Every `row_hash` and `chain_hash` is recomputed from the rows read back. It checks:
  - (a) `chain_seq` runs 1..head with no gaps, per epoch; every seal's epoch is known (epoch 1, or a row of the epoch table); otherwise `audit.seal.unknown-epoch` (F12);
  - (b) every link recomputes from the predecessor's recomputed `chain_hash` (there is no stored `prev` to compare, F4). After a finding the walk re-synchronises on the stored `chain_hash`, so a break is reported where it is and later links are still checked: a changed `chain_hash` breaks its own link and the next. A link is not reported broken for a row already reported as `audit.row.mismatch` when its stored `row_hash` still links;
  - (c) every `row_hash` matches its stored row (detects edits);
  - (d) every row at or below `min(watermark, now - S)` has exactly one seal, and every seal has its row (detects inserts, backdating and deletions); a watermark later than `now - S` is reported as `audit.seal.watermark-future`. Seals are read without the row relation and their rows by `(market_id, id)`, so a seal whose row is gone is `audit.row.missing`, never a crash (Mohammad E1), each row judged against the epoch whose range covers its key (F10). When `audit_log` is later partitioned and its primary key must include `occurred_at`, `id` is no longer unique in the database, so this check then keys on the triple `(market_id, occurred_at, id)`, not on `id` (Hassan, F7 note);
  - (e) every checkpoint matches the chain at its `chain_seq`;
  - (f) only with a bound `AnchorSource` (none in Phase 2: the log anchor cannot be read back): the database head is at or past the latest anchor, the hash at the anchor's `chain_seq` equals the anchor, and every version of an anchor key is identical (detects a cut tail, a fully recomputed chain, or an overwritten anchor);
  - (g) every seal's `audit_occurred_at` equals its row's `occurred_at`;
  - (h) non-late seals are strictly increasing in `(audit_occurred_at, audit_log_id)` along `chain_seq`, and every late seal lies below the non-late seal before it; every late seal is reported on every run as an info line `audit.verify.late-seal` (epoch, `chain_seq`, audit id) and counted in the report (Hassan, 6b review L3);
  - (i) `hash_version` is in the known list and never goes down along the chain;
  - (j) no row has `occurred_at` later than `now + S`: such a row would never be checked by (d) (`audit.row.future`); no time column is outside the range of 7.1 (`audit.row.out-of-range`, `audit.seal.out-of-range`, `audit.checkpoint.out-of-range`, by id or position). A full run looks for out-of-range seals across the Market; an incremental run looks from its walk's start up, with no upper bound at the pinned head (a seal at head + 1 with such a time is visible only to this read), and in every epoch above the known ones (Mojtaba D1);
  - (k) numbers in `before` and `after` are safe integers; others are flagged `audit.row.noncanonical`, because two stored values could then give one hash (Hassan L3).
- **Retention starting point** (Hassan M5 e). After a retention drop, the verifier's starting checkpoint is checked against the anchor, not against `audit_chain_checkpoint`, which the database owner can rewrite.
- Each finding is one error-level log line with a fixed code. Verifier codes: `audit.chain.broken`, `audit.chain.gap`, `audit.seal.unknown-epoch`, `audit.seal.watermark-future`, `audit.row.mismatch`, `audit.row.missing`, `audit.row.unsealed`, `audit.checkpoint.mismatch`, `audit.anchor.mismatch`, `audit.seal.time-mismatch`, `audit.seal.out-of-order`, `audit.seal.hash-version`, `audit.row.future`, `audit.row.noncanonical`, `audit.row.out-of-range`, `audit.seal.out-of-range`, `audit.checkpoint.out-of-range`; and `audit.verify.incomplete` for a run past its budget. It holds Market, `chain_seq` and the audit id, never row content. At most 1 000 lines per code per run, then one line with the number suppressed; the report and the `audit.verify.done` line count every finding per code, and mark a count as a lower bound when its read stopped at the limit (Mohammad 3, Hassan L2). It is marked for alerting (the same mechanism as dead letters, P 6.4; routing is PK3, Phase 7; recipients are Q7). A finding has no automatic effect on business traffic. Making it block traffic would turn tampering into a denial-of-service tool.
- **`AnchorSink`**, a port:
  - **Phase 2 adapter:** a structured log line `audit.checkpoint` (Market, `chain_seq`, `chain_hash` as a `sha256:` `ContentHash`, instant), and `audit.heartbeat` for the daily head. It can be written but not read back, so (f) is a runbook comparison against the logs. Accepted for Phase 2 because no environment is deployed and all data is synthetic (Hassan Q8).
  - **Object Lock anchor, part of the hardening set** (Q6, decided by Ali; Hassan M5; ADR-0032, 15). Due **before the hardening trigger: any non-local environment, shared staging included, that holds non-synthetic data or is reachable by anyone outside the dev team** (15). This is Hassan's stricter wording; it covers Ali's. An Object Lock bucket per Region Stack (ADR-0009 decision 5; ADR-0016 and ADR-0029 client), key `audit-anchors/<market>/<epoch>/<chain_seq>`, heartbeat key `audit-anchors/<market>/heartbeat/<UTC date>`. Each item is a release check, owned by Kazem (the bucket) and checked by Bagher at release:
    - (a) **compliance** mode, never governance mode; retention at least the audit retention (Q5);
    - (b) the application credential may only put objects: no delete, no `BypassGovernanceRetention`, no `PutObjectRetention`, no bucket-policy change. It lives in a different trust domain from the database owner and the people who run the database;
    - (c) every put is a conditional write (`If-None-Match: *`). The verifier reads every version of a key and treats differing versions as `audit.anchor.mismatch`. An idempotent key alone would let an attacker add a new version;
    - (d) a staleness monitor that runs outside the application alerts when a Market has had no anchor object, heartbeat included, for more than 25 hours. Otherwise a compromised worker could stop anchoring and then rewrite freely;
    - (e) after a retention drop, the starting checkpoint is checked against the anchor (above);
    - (f) `AnchorSource`, the readable side, is live before that environment opens, so check (f) runs automatically.
  - **Residual window, written down** (Hassan M5 f). A database owner who rewrites the whole chain is detected only by the anchor. What is not yet anchored can be rewritten without detection: the unanchored tail (up to 1 hour or 10 000 rows since the last checkpoint) plus the unsealed rows (S plus the sealer's lag). A row forged by a compromised application with the current time is not detectable at all (platform.md 3.4).
  - Tests use a recording fake. A failed send alerts `audit.anchor.failed`; the next checkpoint sends again.

## 9. Failure behaviour
| Failure | Behaviour |
|---|---|
| Writer refusal or database error | The unit rolls back and the audited action fails (fail closed). |
| Sealer down or lagging | Business continues; `audit.seal.lagging`. Rows are sealed once it is back. |
| Sealer runs but the head does not move | `audit.seal.stalled` (7.1 step 8); `audit.seal.duplicate-row` when a sealed row was selected again. |
| Watermark later than `now - S` | The sealer stops for that Market; `audit.seal.watermark-future` (7.1 step 2); recovery as 9.1. |
| Lost race (`23505` on the primary key, `55P03`, `40P01`) | Info log; the run ends; the next tick continues (7.2). |
| A row cannot be canonicalised | Sealed with the fallback hash and flagged `audit.row.noncanonical` (6.2); sealing continues. |
| Broken head link | The sealer stops for that Market only; `audit.chain.broken`; the operator follows the runbook and, if needed, opens a new epoch (9.1). The broken segment is never re-sealed or repaired. |
| Verification finding | Alert only. Evidence is never changed. |
| Anchor send fails | The sealer continues; alert; sent again at the next checkpoint. |
| Sealer run throws | `audit.seal.failed` (Market, epoch); the run counts toward `audit.seal.stalled` (7.1 step 8). |
| Checkpoint already at the batch head's position | `audit.checkpoint.conflict`; the batch is rolled back and the Market stalls; recovery as 9.1. |
| Seal or checkpoint time outside `AUDIT_TIME_RANGE` | As 7.1 Time range. |

### 9.1 Recovery: a new chain epoch (Hassan M4, N1 b; due before the hardening trigger, 15)
- A broken link, or a watermark in the future (7.1 step 2), would otherwise stop sealing for good, and an attacker in the api process could cause either by inserting one forged seal. The first defence is the worker-only INSERT group (13). This procedure is what the operator does after a break. The `epoch` itself is in the keys and the hash from 6a (6.2); the command, its tests and the runbook are due at the hardening trigger.
- **Operator command** `audit-chain-new-epoch --market <id> --reason <code>` in the api image, run with a named Market (the pattern of identity 7.4). Reason codes: `broken-link`, `foreign-seal`, `watermark-future`, `operator-error`. It writes the operator log of 9.2 before acting.
- **Epoch table** (DP 11.13): `platform.audit_chain_epochs`, append-only, one row per opened epoch with the reason code, the genesis input and the starting watermark. Epoch 1 is implicit (32 zero bytes, no watermark), so the table stays empty until the first break. Its migration, its grants and the link from the seals are decided with the command, by Mojtaba, before the hardening trigger.
- **Genesis link target, stored and anchored** (Hassan, F4 condition). The command opens epoch n + 1. Its genesis `prev` is the `chain_hash` of the last seal of epoch n that the verifier accepts **and** that matches an anchor. The target `(epoch n, chain_seq, chain_hash)` is stored on the epoch table's row and on the new epoch's genesis checkpoint, and sent to `AnchorSink` at once, with the reason code. The command refuses when no such anchored seal exists. The verifier links epoch n + 1 only to that stored target and checks it against the anchor.
- **Starting watermark** (Hassan N1 b). Computed only from seals of epoch n that the verifier accepts, and never later than `now - S`. It is stored with the genesis target. Within an epoch, the watermark of 7.1 step 2 is the greater of the epoch's starting watermark and the greatest key sealed in that epoch; seals of earlier epochs never count. So a bad watermark of epoch n is not inherited.
- **Rows holding a rejected seal** are sealed again in the new epoch: the seal's unique key is per epoch, `(market_id, epoch, audit_occurred_at, audit_log_id)` (DP 11.3, Mojtaba F13). The rejected seal stays untouched as evidence, and the verifier lists every one of them on every run (`audit.seal.rejected-row`, with epoch and `chain_seq`), so they stay visible. The api role cannot change an audit row, so the new seal covers the original content.
- **Late scan and check (d) after a new epoch** (Mojtaba F10). The late-scan window of the new epoch starts at the epoch's starting key, never below it, so rows sealed in the previous epoch below that key are not taken for unsealed rows. Check (d) judges each row against the epoch whose range covers its key.
- Epoch n, including the broken part, stays untouched. The verifier verifies each epoch on its own and reports the known break once per run, with its epoch.
- Rows of epoch n that were never sealed are sealed in epoch n + 1: in the normal way when above its starting watermark, otherwise as late rows.

### 9.2 Operator log (Hassan L6)
- The operator commands that act as `SYSTEM` (identity's `reset-admin-second-factor` break-glass of slice 7, `first-admin`, and `audit-chain-new-epoch`) first write one line to an external log, outside the application database: the OS user, the host, the command, the Market and the correlation id. The audit row's `correlation_id` is the link. Without it, nobody is accountable for resetting an admin's second factor.
- An optional required ticket reference, of kind `id`, may be added to the command and the row. Decided with slice 7.
- Owner: identity slice 7 for its commands (Hossein), Kazem for the log sink; due before the hardening trigger (15).

## 10. Read access
- **Phase 2 has no read path over HTTP.** Slice 7 and 8a-1 need only the writer. The R11 note of the brief already gives the audit-history key to a later gate.
- **Designed, built with its first consumer:**
  - `AuditTrailReader`, bound per module like the writer. It returns only rows whose `target_type` belongs to that module, in this Market, with keyset paging on `(occurred_at, id)`, plus `chain_seq` and `late`. It is called from the module's own use case, under the module's own protected key. That use case writes its own `<module>.history.viewed` row (VER-14), so the read runs in a read-write unit (W1). First consumer: CERT-32.
  - The reader returns admin `actor_id`s as they are. The consuming module maps them before anything is shown to a seller (CERT-32; Hassan I4).
  - Audited reads (`*.viewed`) write a permanent row on every view. Each such use case is rate-limited when it lands (Hassan I3).
- **The admin audit list across modules** (IMP-10, IMP-06; Q4). Direction set by Ali; final decision at the first admin audit screen:
  - `platform/audit` owns the read use case, behind a protected (R11) key `platform.audit-log.view`, and the read writes a `platform.audit-log.viewed` row (ADR-0026 decision 3 is the precedent);
  - `platform/` imports no module, so it returns ids and codes only. Names are resolved in the panel or composition layer through each module's own permissioned reads, never inside `platform/audit`;
  - the final decision is recorded in that slice's design. If it departs from ADR-0008 ("audit is platform infrastructure"), it needs an ADR. Nothing in Phase 2 depends on it.
- The verifier reads only as the system actor. It is logged, not audited.

## 11. Retention and erasure (ADR-0009 decision 6)
- **Rows hold ids and codes only**, so erasure never touches the audit. Destroying a subject's key affects nothing here, and the chain stays valid.
- After the account row is hard-deleted (identity 11.3), its id in audit rows is a pseudonym with nothing left behind it. Whether keeping it for the retention period is acceptable is part of Q5 for counsel.
- **Retention means dropping whole time partitions** (platform.md 5), up to a checkpoint that has been anchored. Checkpoints are never dropped. The verifier then starts from the earliest retained checkpoint, checked against the anchor (8).
- The seal's foreign key points at `(market_id, occurred_at, id)`, which contains the partition key, so a later time partition of `audit_log` is not blocked (DP 11.2; Ali's note). The constraints for seal retention, including late seals, are in DP 11.9.
- Per-Market retention periods differ, while time partitions span Markets. The choice between partitioning by Market and time or keeping the longest period goes to Mojtaba once Q5 is answered. Nothing in slice 6 depends on it.

## 12. Volume and cost
- **Planning volume:** 10³ to 10⁴ rows a day per Market, including the audited reads of sellers and certification; headroom to 10⁵.
- **Writer:** one INSERT in the caller's unit (about 0.1 to 0.5 ms). It keeps three secondary indexes: the existing time index becomes unique and carries the seal's foreign key (DP 11.2).
- **Sealer, measured** (DP 11.7): a batch of 500 reads in 0.44 ms and inserts in 12.8 ms with the foreign key. Capacity is about 50 rows/s per Market against an average of 1 row/s. The 24-hour late scan costs 22 ms at 10⁴ rows a day, hence its 5-minute cadence (7.1 step 4).
- **Storage, measured:** a seal row is about 240 B including indexes, about 0.9 GB a year per Market at 10⁴ rows a day.
- **Full verification:** the database part is about 2.4 ms per 1 000 seals; hashing in Node dominates, estimated 20 to 60 s per million rows (not measured).
- **Trigger: the first `audit.verify.incomplete` on a full run** (expected near 10 million seals per Market). Then a resumable full verification, or check (d) on its own budget, is designed and built (Mohammad design, Hossein build; Mohammad, 6b round 2 C4).

## 13. Migration (DP 11)
- **One migration, `platform_audit_seal`, in slice 6a**, as designed in DP 11.10. It carries: `ANONYMOUS` in the actor CHECK; the millisecond CHECK on `occurred_at`; the existing time index made unique; `audit_log_seal` and `audit_chain_checkpoint`, append-only, `SELECT, INSERT` for the application group; the privilege map, the role test and the widened self-check.
- **Key shape** (F7): the seal's primary key is `(market_id, epoch, chain_seq)` and the checkpoint's key carries `epoch` too (NOT NULL, starting at 1; Ali 2026-10-08), its unique key is `(market_id, epoch, audit_occurred_at, audit_log_id)` (F13), and its foreign key is `(market_id, audit_occurred_at, audit_log_id)` to `audit_log (market_id, occurred_at, id)`, `ON DELETE RESTRICT ON UPDATE RESTRICT`, never `CASCADE` (Hassan I2). Hash columns are 32-byte `bytea` (F8). No `prev_chain_hash` (F4). Hassan accepted F4 and F7 on 2026-10-08; the foreign key stays.
- **`down.sql`** mirrors the up. It fails once an `ANONYMOUS` row exists, which is correct (identity data 8.2).
- **Worker-only INSERT group** (Hassan M4; DP 11.6). Before the hardening trigger (15), no longer "with PH4" (Ali): INSERT on the seal and checkpoint tables goes to a worker-only group, and the api role keeps SELECT only. Owner: Mojtaba and Kazem.
- **Decided in DP 11, and still open:**
  - **Size cap on `before` and `after`** (Hassan L3): CHECK `octet_length(before::text) <= 8192` and the same for `after` (DP 11.2, Mojtaba F9), in the 6a migration while the table is empty, with a database test. Not `pg_column_size`: it measured 24 562 bytes of jsonb for 4 KB of canonical JSON, so it could refuse writer-valid entries (Hassan I-a answered). The writer's 4 KB limit on canonical JSON (W4) is the primary control. Due before 6a merges.
  - **Epoch, in the 6a migration** (Ali 2026-10-08; DP 11.13): `epoch integer NOT NULL`, CHECK `>= 1`, no default, in both primary keys and the seal's unique key. The epoch table of 9.1, its grants and the seal link are decided with the recovery command, before the hardening trigger (Mojtaba).
  - **`transaction_timeout`** on the login roles (Hassan L4), with Kazem's K1a settings and the role-settings test. Due before the hardening trigger (15).
  - **Job-lock transaction** (Mojtaba F11, DP 11.14): the scheduler's job-lock transaction, which writes nothing, sets `SET LOCAL transaction_timeout = 0`. Measure on PostgreSQL 17 that this, inside an open transaction, cancels the running timer, before relying on it (hardening set, 15).

## 14. Ordering question: 8a before slice 7
**Answer: yes, split it** (accepted by Ali 2026-10-08).

| Part | Needs an admin actor or slice 7? | Slice |
|---|---|---|
| Permission registry (platform/authz, boot-time; retired list) | No | **8a-1**, right after 6b |
| identity permission catalogue (`contracts/permissions.ts`, 5.3) | No | 8a-1 |
| Permission path of `AuthorisationCheck` (effective keys from the role; registry check, R7) | No. Seller actors already exist (the Seller Owner holds the seller system role). Admin cases are tested with fixture accounts written through the repository | 8a-1 |
| `GrantPolicy`, `LastHolderPolicy` as domain services with unit tests | No (pure) | 8a-1 (or with their first use case; HF5 and HF8 go with the callers) |
| Default-role seed and the seed-version upgrade of system roles (system use case, per Market, one audit row per change) | No; system actor; **needs 6b** | 8a-1 |
| `membershipOf` for other accounts (`identity.team-member.view`, seller scope) | No | 8a-1 |
| Swap `NO_PERMISSION_KEYS` for the registry in the outbox and the audit writer | No | 8a-1 |
| Assign an admin's role (`identity.platform-role.assign`; serializable; HF8 test) | **Yes:** needs admin accounts and sessions (slice 7) | **8a-2**, after 7, with 8b |

**Order: 6a → 6b → 8a-1 → 7 → 8a-2 with 8b.**

Conditions on 8a-1 and 8a-2 (Ali):
1. In 8a-1, admin fixture accounts exist only in tests. No seed, dev route or script creates an admin before slice 7.
2. 8a-1 swaps out `NO_PERMISSION_KEYS` in the outbox and in the audit writer in the same PR that brings the registry.
3. 8a-1 includes the seed-version upgrade of system roles (an audited update, not `ON CONFLICT DO NOTHING`; Ali 2026-10-08).
4. Hassan's checks: 8a-1 gets HF5 and R7; 8a-2 gets HF8, with the serializable race test.
5. identity.md 12.1 and 12.2 and the owner estimate are updated (one more PR for this split).

Notes:
- The brief's rule that admin invitation and role grants come after admin sign-in with a second factor (brief s11, slice 7 row) still holds, because admin assignment is in 8a-2.
- 8a-1 satisfies the ADR-0015 decision 3 registry trigger, read as "no later than" under ADR-0023. Certification slice 1 and inventory need only 8a-1 to declare keys and get default-role membership. Their admin endpoints cannot be used end to end until slice 7, but they can merge and be tested.
- **What slice 6 must provide for 8a-1:**
  - the writer bound to identity (6b);
  - `system` and `authenticated` actor kinds;
  - `listOf(permissionKey)` with a maximum, validated through the shared `PermissionKeyLookup` (fail-closed until 8a-1 swaps in the registry, so no key-bearing row can be written before then);
  - the catalogue and snapshot test, which 8a-1 extends with `identity.role.seed-applied` and `identity.account-role.assigned`;
  - the sealer.
- Because the system-role seed rows carry no keys (system roles store none), 6b's retrofit works before 8a-1.

## 15. Slices, entry and exit, document changes
- **Slice 6 as a set of two PRs** (ADR-0015 decision 1: no caller writes a row until both are merged; accepted by Ali as one slice set):
  - **6a**: kernel `ContentHash` and `canonicalJson`; `defineAuditAction`; catalogue; writer with tests only; the migration of 13.
  - **6b**: sealer, verifier, checkpoints, log `AnchorSink`, operator command `audit-verify`; the identity retrofit of section 5 (seed and founding rows); the identity action definitions; the writer bound to identity.
- **Conditions on the split (Ali):**
  1. 6a binds no `AUDIT_WRITER` provider into any module. The writer is reachable only from tests, and a boundary or contracts test proves it (16).
  2. 6b merges before any other slice that writes an audit row (7, 8a-1, sellers, certification).
  3. Both PRs get a mandatory Hassan review.
  4. 6a carries the only migration, and no other migration PR is open while it is.
  5. The kernel `ContentHash` and `canonicalJson` change is announced on the board, because it is the shared kernel and sellers slice 5 waits on it.
- **Entry criteria for 6a** (Ali's final ruling, 2026-10-08; 6a may start when all hold):
  1. Hassan confirms F4 and F7: done 2026-10-08 (18);
  2. Mojtaba finishes DP 11: **done**, data design signed off 2026-10-08 (size CHECK `octet_length(...::text) <= 8192` with its database test, `epoch` in the keys, per-epoch unique key, A3 amendment in identity data 6);
  3. the design edits of Ali's final ruling (F3 decided with the scan on start, epoch in the 6.2 hash input, one trigger wording): done in this revision;
  4. identity slice 5 merged, and no other migration PR open;
  5. the kernel `ContentHash` and `canonicalJson` change announced on the board.
- **Before 6b merges** (Hassan's re-review): the stall fixes of N1 (a) and (c) with their tests (7.1 steps 2 and 8, 6.2, 16); ADR-0032 merged, so the trigger is on record before the first audit row can exist (Ali).
- **Exit criteria (Ali's binding input):** audit rows for the seeded system roles, the founding membership and the founding assignment (6b), plus everything in section 16. No environment of the hardening trigger opens before slice 6 is merged and the hardening set below exists.
- **Hardening trigger** (one wording for every item below, decided by Ali 2026-10-08): **any non-local environment, shared staging included, that holds non-synthetic data or is reachable by anyone outside the dev team.** ADR-0015 decision 2 (database roles before any shared or deployed environment) is unchanged. **Hardening set**, due before that trigger, a release check for Bagher:
  - Object Lock anchor with items (a) to (f) of 8 (M5; Kazem);
  - worker-only INSERT group (13; M4; Mojtaba, Kazem);
  - chain-epoch recovery: command, tests and runbook (9.1; M4, N1 b; Mohammad designs, Hossein builds, Mojtaba the genesis row shape; the `epoch` column itself is in 6a);
  - `transaction_timeout` on the login roles (7.2; L4; Kazem, Mojtaba);
  - measured on PostgreSQL 17: `SET LOCAL transaction_timeout = 0` inside an open transaction cancels the running timer, for the scheduler's job-lock transaction (13; Mojtaba F11; Hossein, Mojtaba);
  - operator log for `SYSTEM` commands (9.2; L6; Hossein, Kazem);
  - Q5 and Q7 answered by the owner (17).
- **ADR-0032 (audit-chain hardening)**, a shared file in its own PR (#97). It amends ADR-0015 decision 3 with one row for the hardening set and its trigger, and records the coupling between the timeout ceilings and S. CTO acceptance is enough; it must merge before 6b merges.
- **Edits to other documents:**
  - identity.md 5.5, 10.1, 12.1, 12.2, 14.1-2 row 2, the "as built" rows of slice 5, 14.5 item 3 (done with this revision);
  - identity brief change log (done); certification.md 3.7, 7.6, 11, 16.1 and the certification brief change log for Q3 (done);
  - identity data 6: the A3 amendment of W4a (Mojtaba);
  - PF 2 row 1 and 3.8 (`ContentHash` decided here);
  - P 3.3 row, P 7 "Phase 2" (platform jobs `platform.audit-seal` and `platform.audit-verify`), P 8 (the worker runs the sealer);
  - sellers.md 2.4 rule 3;
  - the data designs of sellers, catalog and certification: a one-line note on the `content_hash` CHECK, with Mojtaba's sign-off; certification data 3.2: the audit row no longer carries `change_reason` (Q3);
  - platform.md 3.5 and Q1 closed (DP 11);
  - the runbook (Kazem): check (d) as the backstop for late rows beyond 24 hours, F6 replication stalls, `audit.seal.watermark-future`, the epoch command.

## 16. Test plan (every database test runs for AU and ZZ; `FakeClock`; offline)
- **Unit:**
  - `canonicalJson` against the RFC 8785 vectors, plus non-ASCII and astral-plane key sorting, and each refusal of 6.3 (`Date`, `Map`, `toJSON`, `BigInt`, cycles, lone surrogates; `-0` written as `0`);
  - golden hash vectors (fixed rows give fixed `row_hash` and `chain_hash`, with `hash_version` and `epoch` in the chain input, including an epoch 2 vector, checked in);
  - the fallback row hash of 6.2 for a row that `canonicalJson` refuses, always with `audit.row.noncanonical`;
  - `ContentHash` parse cases;
  - definition validation (vocabulary, foreign prefix, `platform.<component>` prefix, duplicate, `listOf` without a maximum, `anonymous` without `boundSubjectId`);
  - every writer refusal code, including a too-long list, an oversize `before` or `after`, and an `ANONYMOUS` entry without `boundSubjectId`;
  - actor mapping for the three kinds;
  - millisecond cut;
  - the S bound assertion;
  - settle and watermark logic: the watermark is the greatest sealed key, never the head's;
  - checkpoint only when the head moved; the heartbeat writes no checkpoint row;
  - the late scan runs at most every 5 minutes per Market, and on the first run after the worker starts;
  - `audit.seal.stalled` after 3 runs without progress while settled unsealed rows exist, both above and below the watermark;
  - a watermark later than `now - S` stops the Market with `audit.seal.watermark-future` and seals nothing;
  - a sealer run that throws counts toward `audit.seal.stalled` and alerts `audit.seal.failed`; check (d) skips empty days and stops at `now - S`; a run past its budget ends `audit.verify.incomplete`; counts per code beyond the cap; late seals reported and checked (6b review);
  - verifier detection on in-memory chains: edit, gap, extra row, broken link, checkpoint mismatch, tail cut against an anchor, two differing anchor versions, a future row, a non-safe integer, `audit_occurred_at` differing from `occurred_at`, non-late seals out of order, a lowered `hash_version`, a tampered stored `row_hash` with an unchanged row, **a row that canonicalises but carries a fallback-style `row_hash` (reported as a mismatch; Hassan N1 c)**, a segment of one epoch spliced into another, and a head that moves during the run (verification stops at the pinned head).
- **Database:**
  - the writer's row commits with an `ok` unit and is absent after `err` or a throw;
  - read-only unit and Market mismatch are refused;
  - an `ANONYMOUS` row is accepted, and `ANONYMOUS` with an `actor_id` is refused;
  - an insert with microsecond `occurred_at` through the owner connection is refused (`23514`); an oversize `before` or `after` is refused by the size CHECK, including a large but highly compressible value (6a; Hassan L3, I-a);
  - AU and ZZ chains are independent, each starting at epoch 1, `chain_seq` 1;
  - **watermark in the future** (Hassan N1 a; before 6b merges): through the owner connection, insert an audit row with a future, millisecond-aligned `occurred_at` and a seal for it at head + 1 with a correct chain hash; the next run stops that Market with `audit.seal.watermark-future`, `audit.seal.stalled` fires while new rows wait, and AU and ZZ stay independent;
  - rows inside S are not sealed;
  - two concurrent sealers give a contiguous chain with no duplicates; the loser ends with `23505`, `55P03` or `40P01` and never raises `audit.chain.broken`;
  - **conflict classifier** (7.1): it reads the constraint name. A lost race on the primary key `(market_id, epoch, chain_seq)` (two sealers on one head) ends the run at info level; a re-selected row on the unique key `(market_id, epoch, audit_occurred_at, audit_log_id)` (a seal inserted for a selected row by another session, the head unchanged) gives `audit.seal.duplicate-row`. One database test for each;
  - a seal with `epoch = 2` inserted through the owner connection while the epoch table is empty does not move the sealer (it stays on epoch 1) and the verifier reports `audit.seal.unknown-epoch` (F12);
  - **late row** (Hassan M1, Mojtaba F1): a backdated row inserted through the owner connection is sealed `late` and alerts; then a normal run seals new rows, the chain keeps growing, and no `23505` occurs;
  - a row with a jsonb number beyond the double range, inserted through the owner connection, is sealed with the fallback hash and flagged, and the rows after it are sealed;
  - tampering through the owner connection, with triggers disabled only in the test as the migrator (edit `after`; delete a row and its seal; cut the tail; change a `chain_hash`; change a seal's `hash_version`), is detected by the verifier with the right code and seq, and ZZ tampering never flags AU;
  - **with the seal's foreign key dropped** as the migrator in the throwaway database and restored after (Mohammad E1): a sealed row deleted gives `audit.row.missing` and the verification completes; a seal's `audit_occurred_at` changed gives `audit.seal.time-mismatch`. With the `hash_version` CHECK dropped the same way, a seal set to version 2 gives `audit.seal.hash-version` and `audit.chain.broken` (Mohammad 12);
  - **times out of range** written by the application login (Hassan M1, Mojtaba): rows at `infinity`, `-infinity` and year 280000, a seal with `sealed_at = infinity`, a checkpoint with `created_at = infinity`; the sealer seals the other rows, the verifier names each by id and completes, and the command exits 2. With the `sealed_at = infinity` seal at head + 1, the sealer ends lost-race or duplicate-row and seals nothing more; the verifier reports `audit.seal.out-of-range` only. A checkpoint at the position a batch reaches gives `audit.checkpoint.conflict`;
  - a refused audit row rolls back the seed of a role, and the whole Seller Owner verification (no registration, session, event or row) (Sajad L5);
  - the application role gets `42501` on UPDATE, DELETE, TRUNCATE and `SELECT ... FOR UPDATE` of both new tables, and the owner gets `23001` on UPDATE, DELETE and TRUNCATE;
  - the privilege map and the self-check are updated.
- **Contracts:**
  - snapshot of the audit action catalogue;
  - the boundary fixture: no module imports `platform/persistence/audit`; no factory token;
  - **6a only:** no module binds an `AUDIT_WRITER` provider (Ali's condition 1 on the split); 6b changes the expectation to "identity only".
- **Identity integration (6b):**
  - the seed writes `identity.role.seeded` once per system role per Market, and a second run writes none;
  - Seller Owner verification writes the three founding rows in its unit, each with `sellerId`, `accountId` and `boundSubjectId`;
  - a failed verification and the unverified purge write none;
  - AC 12 scan: no email, name or reason text in any row.
- **Before the hardening trigger** (with their items in 15):
  - the epoch command: a broken link (and, separately, a future watermark), then a new epoch whose genesis target is stored and anchored at once; its starting watermark comes only from verifier-accepted seals and is never later than `now - S`; the old epoch is untouched and still reported; rows holding a rejected seal are sealed again in the new epoch and the rejected seal is listed by the verifier on every run (Hassan N1 b, F13); the new epoch's late scan starts at its starting key and check (d) judges rows by the epoch that covers them, so no row of the old epoch is reported unsealed (F10);
  - `transaction_timeout` in the role-settings test;
  - the api role refused INSERT on the seal tables.

## 17. Open questions
| # | For | Question | Status |
|---|---|---|---|
| Q1 | Ali, Hassan | Founding rows at email verification (anonymous actor), changing identity 5.5 and 10.1 | **Decided** by Ali 2026-10-08: accepted with three conditions (5) and Hassan's M3 (W4a) |
| Q2 | Ali | Option A, settled order with `late` rows (6.1) | **Decided** by Ali 2026-10-08: A, with three conditions (7.2) |
| Q3 | Ali, Hassan | certification.md 11 allowed free text in `claim-policy.revised` `after` | **Decided** by Ali 2026-10-08: the reason lives on the revision only; the audit row carries the revision id and `reasonGiven`; all four reason sites (certification.md 11). Hassan's L5 residual is recorded there |
| Q4 | Ali | Owner of the cross-module admin audit list | **Direction decided** by Ali 2026-10-08 (10); final at the first admin audit screen |
| Q5 | Owner (counsel) | Audit retention per Market, and keeping pseudonymous ids after erasure | **Open for the owner.** Goes to counsel with the open certification retention items. Due before the hardening trigger (15); Mojtaba needs it before he designs partitioning |
| Q6 | Ali, Kazem, Bagher | External readable anchor (Object Lock) as a release trigger | **Decided** by Ali 2026-10-08, with Hassan's stricter wording and conditions (8), as one trigger for the whole hardening set (15); ADR-0032 |
| Q7 | Owner | Who receives audit-integrity alerts (a named person per Market or Region Stack) | **Open for the owner.** Asked together with Q5; due before the hardening trigger (15). Recommendation (Ali): the owner plus the CTO, with Kazem's on-call for operations; never only someone with database write access |
| Q8 | Hassan | Is the log anchor enough for Phase 2? Is the hash construction of 6.2 sound? | **Decided** by Hassan 2026-10-08: yes to both, with L2 applied (6.2) and the hardening trigger wording (15) |

## 18. Review record
Reviews of 2026-10-08: Ali (cto, approved with conditions; second round: final ruling, 6a may start when the conditions of 15 hold), Hassan (security-tester, mandatory, OK with conditions; re-review OK with conditions), Mojtaba (database-designer, OK with conditions; final: data design DP 11 signed off, with F9 to F13).

| Item | Finding or condition | Where applied, or trigger and owner |
|---|---|---|
| Ali Q1 | Founding rows at verification; actor `ANONYMOUS`; target the account or the seller access record with `sellerId` and `accountId`; no backfill | 5; identity.md 5.5, 10.1, 14.1-2 row 2 |
| Ali Q2 | Option A; S test; no override above the ceiling; daily verify as backstop | 6.1, 7.2, 7.1 step 4; runbook (15, Kazem) |
| Ali Q3 | Reason on the revision only; audit row carries the revision id; all four reason sites | 3.2; certification.md 3.7, 7.6, 11, 16.1; certification brief change log |
| Ali Q4 | Direction for the admin audit list; `platform.<component>.*` writers | 10; 3.2 |
| Ali Q6 | Object Lock release trigger; compliance mode; put-only credential; `AnchorSource` live | 8; ADR-0032 (15); Kazem owns the bucket, Bagher checks at release |
| Ali 8a split | 8a-1 / 8a-2, five conditions | 14; identity.md 12.1, 12.2 |
| Ali 6 split | 6a / 6b, five conditions | 15; 16 contracts; identity.md 12.1, 12.2 |
| Ali note for Mojtaba | Foreign key through `(market_id, occurred_at, id)` for later partitioning | DP 11.2, 11.3; 11 here |
| Ali paperwork | One ADR; brief change logs; content-hash note | 15 (ADR-0032); identity and certification briefs |
| Ali Q5, Q7 | On the owner's queue, due before the hardening trigger | 17, 15 |
| Hassan M1 = Mojtaba F1 | Watermark went backwards; stall | 7.1 step 2, duplicates, step 8 (`audit.seal.stalled`); 16 late-row test |
| Hassan M2 | Microsecond precision; no row may stop the sealer | W3 and DP 11.2 CHECK; 6.2 fallback; 16 |
| Hassan M3 | Anonymous rows must name the bound account | W4a, 3.2, 4, 5; A3 amendment to identity data 6 (Mojtaba) |
| Hassan M4 | api can stop the chain; no recovery | 13 worker-only group, 9.1 epoch; before the hardening trigger (Mojtaba, Kazem, Hossein); `epoch` in keys and hash from 6a |
| Hassan M5 | Object Lock minimum, (a) to (f) | 8; release check (Kazem, Bagher) |
| Hassan L1 | Verifier gaps | 8 checks (b), (f) to (k), pinned head; 16 |
| Hassan L2 | `hash_version` bound into the chain | 6.2; 8 (i); 16 golden vectors |
| Hassan L3 | `listOf` maximum; size cap; non-safe integers | 3.2, W4; 13 (size CHECK in the 6a migration with a database test, before 6a merges; Mojtaba); 8 (k) |
| Hassan L4 | `transaction_timeout` on login roles | 7.2; 13; before the hardening trigger (Kazem, Mojtaba) |
| Hassan L5 | Reason on the revision still cannot be erased | certification.md 11 (destroyable-key encryption or explicit risk acceptance through counsel; `{revisionId, reasonGiven}`); before the certification slice that writes reasons |
| Hassan L6 | Break-glass reset recorded as `SYSTEM` | 9.2; 5 row 7; identity.md 7.4 note; slice 7 |
| Hassan I1 | `canonicalJson` refusals and vectors | 6.3; 16 |
| Hassan I2 | Foreign key `RESTRICT`, never `CASCADE` | 13 (DP 11.3 already does it) |
| Hassan I3 | Rate-limit audited reads | 10 |
| Hassan I4 | Reader returns admin actor ids; consumer maps them | 10 |
| Hassan Q8 | Trigger wording: the stricter one | 8, 15 |
| Mojtaba F2 | Checkpoint only when the head moved | 7.1 steps 5 and 6 |
| Mojtaba F3 | Late scan at most every 5 minutes per Market | 7.1 step 4, 12; decided by Ali 2026-10-08, with a scan on the first run after worker start |
| Mojtaba F4 | No `prev_chain_hash` | 6.2, 8 (b), 13, 16; accepted by Hassan 2026-10-08, on condition that the chain start is stored and anchored (6.2, 9.1) |
| Mojtaba F5 | Lost race is `23505`, `55P03` or `40P01`; no row locks | 7.2, 9, 16 |
| Mojtaba F6 | Synchronous replication can delay visibility | 7.2; runbook note (Kazem) |
| Mojtaba F7 | Key shape through `audit_occurred_at` | 7.2, 13; accepted by Hassan 2026-10-08, foreign key kept; check (d) keys on the triple once `audit_log` is partitioned (8) |
| Mojtaba F8 | `bytea` hash columns | 6.3, 13 |
| Ali round 2 (1) | F3 decided; scan on the first run after worker start | 7.1 step 4, 16 |
| Ali round 2 (2) | Estimate 19 steps, about 27 PRs, confirmed | identity.md 12.1 |
| Ali round 2 (3) | One trigger wording for the whole hardening set, Q5 and Q7 included; worker-only group at that trigger; `epoch` NOT NULL from 1 in the keys and `uint32be(epoch)` in the chain hash from version 1 | 15 (definition), 8, 9.1, 9.2, 7.2, 13, 16, 17; 6.2; DP 11 (Mojtaba) |
| Ali round 2 (4) | ADR approved after edits; merged before 6b | 15 (ADR-0032) |
| Ali final ruling | 6a may start when five conditions hold | 15 entry criteria |
| Hassan N1 (a) | Watermark in the future; stalled condition either side of the watermark | 7.1 steps 2 and 8, 9, 16 database test; before 6b merges |
| Hassan N1 (b) | Epoch recovery: starting watermark from accepted seals only and never later than `now - S`; rows with rejected seals kept as evidence and listed; stored, anchored genesis target | 9.1, 6.2, 16; per-epoch unique key decided by Mojtaba (F13); before the hardening trigger |
| Hassan N1 (c) | Fallback hash chosen only by whether `canonicalJson` refuses the row | 6.2, 16 verifier test; before 6b merges |
| Hassan I-a | `pg_column_size` may report the compressed size | Answered by Mojtaba's measurement: the CHECK is `octet_length(...::text) <= 8192` (13; F9) |
| Hassan I-b | `audit.row.noncanonical` flag mandatory | 6.2, 16 |
| Mojtaba final | Data design DP 11 signed off 2026-10-08 | Status line; 15 entry criterion 2 |
| Mojtaba F9 | Size cap as `octet_length(before::text) <= 8192` and the same for `after`, not `pg_column_size` | 13; 16 |
| Mojtaba F10 | After a new epoch, the late scan starts at the epoch's starting key; check (d) judges each row by the epoch that covers it | 7.1 step 4, 8 (d), 9.1, 16 |
| Mojtaba F11 | `SET LOCAL transaction_timeout = 0` in the job-lock transaction, to be measured on PostgreSQL 17 | 13, 15 hardening set |
| Mojtaba F12 | The current epoch is never read from the seals; unknown epochs are a verifier finding | 6.2, 7.1 step 1, 8 (a), 16 |
| Mojtaba F13 | Per-epoch unique key; rows holding a rejected seal are sealed again in the new epoch | 6.2, 7.1, 7.2, 9.1, 13, 16; the "open for Mojtaba" point removed |
| 6b review: Hassan M1 to M3, L1 to L4 | Out-of-range times stop the sealer; a thrown run never stalls; (d) walks every day, unbounded run; anchors dropped above info; counts past the cap; late seals; exit code for an incomplete run | 7.1 (time range, step 8), 8 (schedule, budget, (d), (h), (j), codes, cap, exit codes); the worker refuses `LOG_LEVEL` above info; the DB CHECK of M1 (3) is Mojtaba's DP 11.15, not in 6b |
| 6b review: Mohammad 1 to 13 and E1 | Totals per code; incremental (d) start; exit 3 and no error text; tenant line; reshape note; hash-version DB test; missing row crashed verify | 8, 6.2, 5 row 2, 16 |
| 6b review: Sajad M1, M2, L1 to L6, I1 | Anchor line test; epoch splice; lowered version; forced race; late then normal run; duplicate-row on Postgres; rollback tests; command runbook note | 16; README of `platform/persistence` (runbook note for Kazem) |
| 6b review: Mojtaba C1, C2, L1 to L4, sign-off | Index-friendly epoch and duplicate reads; rows-wait probe order; checkpoint conflict alert; trigger toggling in one transaction; time guard on all three columns, one range constant | 7.1, 7.2, 16; sign-off conditional on the time guard, now applied |
| 6b review round 2: Mohammad C1 to C6 | Incomplete full run not counted; findings win the exit code; out-of-range seal blocks the sealer; (d) skipped when incomplete, with a trigger; 16 wording; review-row wording | 7.1, 7.2, 8, 9, 12, 16, 18 |
| 6b review round 2: Mojtaba C1, C2, L1 to L3, D1 (EXPLAIN at 1.1M seals) | C1, C2, L1 to L3 confirmed as measured; D1: the incremental out-of-range seal read scoped to the walk's start up and to unknown epochs, open upwards; Prisma's log form of the upper bound | 8 (j), 16; README of `platform/persistence` (runbook line) |
