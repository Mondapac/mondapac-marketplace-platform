# Tax — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-08
**Status:** **G2 approved with conditions 2026-10-08 (Ali, Hassan); owner informed.** Ali (cto) approved with changes, Hassan (security-tester) accepted with changes (H1 to H7), Mojtaba's data design (`docs/design/data/tax.md`) is reviewed; all are applied here (section 17). Conditions: Hassan checks H3 and H5 at code time; the CODEOWNERS change of H3 lands in its own board-announced shared-file PR; Mojtaba's data-design changes (Mojtaba change list 2026-10-08) land before the slice that needs them; Reza (UI) for s12 (slice 6, P1) pending. Tier A (brief header): Hassan's review is mandatory at G2 and before every slice that computes money or shows an invoice rule (brief s9). Code of slices 3, 4 and 5 also waits for the tax agent's written confirmation (owner Q1(b); Ali G1 ruling 2; ADR-0036, ADR-0036 draft, accepted by Ali). Slices 1 and 2 may proceed (Ali G1 ruling 6). Open: section 15; review record: section 17.
**Ground truth:** `docs/modules/tax/brief.md` (G1 approved by the owner 2026-10-08; sections, owner answers and acceptance criteria are cited as "brief s5", "Q7", "AC 4", ACs numbered in the order of brief s10); ADR-0007 (decisions 1 to 11; the design implements them, it changes none); ADR-0001 (decision 1, extension points), 0002 (Market, `legal_entity`, one currency per Market), 0003 (decisions 3, 5, 9), 0005 (decisions 2, 3, 5, 8), 0006, 0008, 0009 (V2, V3), 0013, 0018 (decision 4, access rules), 0019 (decision 8 and 10, R2), 0020, 0022, 0024, 0025 (decision 1), 0026 (decision 6 and 9: tax configuration is never an editable setting); `docs/features/09-internationalization.md` (INTL-02, INTL-30); `docs/architecture/internationalization-architecture.md` s5; the Phase 5 briefs `docs/modules/ordering`, `payments`, `commission-payouts` and `shipping` (`brief.md`); `docs/modules/sellers/brief.md` and `docs/design/domain/sellers.md` ("SEL 7.1"); `docs/design/domain/pricing.md` ("PRC"; the structure of this document follows it); `catalog.md` ("CAT"); `platform-foundations.md` ("PF") and `platform-persistence-and-events.md` ("PE"); `packages/shared-kernel/src/money.ts` (`Money`, `scaleMoney`, `allocateMoney`); `apps/api/src/platform/market-config/market-config.ts` and `config/markets/AU.json`, `test/fixtures/markets/ZZ.json` (today's Market files).
**Phase 5 rulings kept outside the repo (read 2026-10-08):** Ali Phase 5 review 2026-10-08 (A ruling 6: ownership), Ali G1 review 2026-10-08 (rulings 2, 6, 7), Phase 5 owner questions 2026-10-08 (answers Q1, Q2, Q7, Q10, Q11), Ali G2 review 2026-10-08 ("Ali G2", binding), `docs/design/data/tax.md` (Mojtaba's data design, "TD"; its points M1 to M4).

> ADR-0007 says of itself: "this ADR is architecture, not tax advice". Every GST rule below is a **working assumption** until the registered tax agent confirms it in writing. The items the agent must confirm are collected in section 15.3 (the "agent list"); the numeric cases are the worked-example set of 13.3.

## 1. Scope

A design, not an implementation. Signatures appear only where the signature is the contract.

- **Decided here:** domain model (2), lifecycle (3; `tax` has almost no state), tax rules (4), authorisation (5), boundary, facade and events (6), data ownership (7), audit (8), idempotency and concurrency (9), where each hard rule is enforced (10), jobs (11), AI (12), slices and tests (13), what is deferred (14).
- **In Mojtaba's data design** (`docs/design/data/tax.md`, written from this model): the slice 6 tables, constraints, indexes, grants and migration plan; and his review of the snapshot columns `ordering` freezes from `tax`'s answers (PD7, which his `ordering` data design owns). Section 7 names the data only, plus inputs PD1 to PD8.
- **In Reza's and Jafar's documents:** the threshold banner and status (slice 6, P1). Invoice, adjustment and commission-statement templates belong to `ordering` and `commission-payouts`; `tax` gives them codes and label keys only (brief s12, 6.2).
- **Left open, with the reason:** section 15. Each item is a tax-agent ruling, a CTO call or a security call that this design must not invent.

### 1.1 Brief slices and where they are covered
| Slice (brief s11) | Covered in | Gate |
|---|---|---|
| 1 Root: rate type, `TaxStrategy`, registry, Market tax configuration, AU and synthetic Market, rounding property tests (INTL-30) | 2, 4.1 to 4.3, 4.7, 10, 13 | Hassan; free to code (ruling 6) |
| 2 Line tax extraction with category and seller registration; facade for `ordering` (incl. the flat shipping fee) | 4.4, 4.5, 6.2 `calculateOrderTax` | Hassan; free to code (ruling 6); shipping GST a frozen working assumption |
| 3 Document kind, required content, thresholds, issue date in the seller's zone, partial invoices (ORD-05) | 4.6, 6.2 `decideInvoiceDocument` | Hassan; **blocked until the agent's written confirmation** |
| 4 GST reversal for refunds and adjustments (ADR-0007 decision 11) | 4.8, 6.2 `reverseRefundTax` | Hassan; **blocked until the agent's written confirmation** |
| 5 GST on commission, both entity states (Q1, Q7), and its reversal from the frozen entry (TD M4) | 4.9, 6.2 `commissionTax`, `reverseCommissionTax` | Hassan; **blocked until the agent's written confirmation** |
| 6 Registration-threshold warning (P1 after launch) | 4.10, 6.3, 6.4, 11 | Hassan; T3 (turnover port) decided first |

## 2. Domain model

### 2.1 What `tax` is
`tax` is a **calculator with configuration**, not a record keeper. It owns the meaning of tax rules and answers questions; `ordering` freezes the answers on its snapshot and documents, and `commission-payouts` freezes them in its ledger (ADR-0007 decision 8; review-ali A ruling 6). Slices 1 to 5 hold no table and write nothing. Only slice 6 (P1) owns state: the threshold alerts. Sales figures are read from `ordering` through a port (T3).

```
TaxRuleSet         (per Market, effective-dated, checked-in configuration; V2 in code)
  |-- RuleSetId, validFrom (instant), strategyCode
  |-- CategoryTreatment (1..n)  categoryCode -> { kind: rated | free, rate: TaxRate, labelKey }
  |-- ChargeTreatment           shipping -> categoryCode (frozen working assumption, 4.5)
  |-- CommissionSupply          categoryCode, priceBasis: exclusive (4.9)
  |-- RoundingPolicy            mode: half-up, level: line
  '-- DocumentPolicy            thresholds (Money), document kinds and their required fields (4.6)
LegalEntityProfile  (platform MarketConfig `legalEntity`, not tax data; read only, 4.9)
SellerTurnoverSource (slice 6, P1; a port tax declares and ordering implements; no tax copy, T3)
ThresholdAlert      (slice 6, P1; one per seller per crossing episode)
```

| Aggregate or configuration | Holds (logical) | Invariants it owns |
|---|---|---|
| `TaxRuleSet` (configuration, not a table) | Id (e.g. `AU-2026-1`), `validFrom` (UTC instant), strategy code, category treatments, charge and commission treatment, rounding policy, document policy, registration threshold, warning ratio and clear ratio (4.10) | Rule sets of a Market are ordered by `validFrom`, strictly increasing, and the first one starts no later than the Market's first sale; a rule set's content never changes once its `validFrom` has passed (13: the pin test); every rate is an exact decimal (ADR-0007 decision 2); a `rated` treatment has a rate > 0 and a `free` one has rate 0 (TD 10.1.1 backstop); every Money is in the Market currency; the category codes are exactly the codes of the Market's `catalog.taxCategories` (4.2); rounding mode `half-up` and level `line` are the only values accepted today (fail closed at boot) |
| `ThresholdAlert` (slice 6) | Seller id, crossing instant, the trailing window (`[from, to)`) and the seller zone it was computed in, the rule set id, threshold, warning ratio and currency, the trailing total at crossing, cleared instant and clear cause (`below-ratio`, `seller-registered`) (TD 3.2). Open = no cleared instant; no state field | At most one open alert per seller; a new one only after the trailing total fell below the ratio and crossed again ("once per crossing", brief s4 flow 6) |

### 2.2 Value objects and domain services
| Name | What it is |
|---|---|
| `Money` (shared kernel) | `{ amount: bigint minor units, currency }`; `scaleMoney(m, n, d, mode)` and `allocateMoney(whole, weights)` already exist in the kernel (ADR-0007 decisions 1 and 2) |
| `TaxRate` | An exact non-negative rational `n / 10^k` parsed from the decimal string in configuration (`"0.10"`, `"0.15"`, `"0"`), at most 6 decimals, at most 1. Never a float. Serialised as a decimal string and stored as `numeric` where a module stores it. **Rates are compared by numeric value, never by text** (`"0.10"` equals `"0.1"`): neither `numeric` nor `Prisma.Decimal` keeps the text form (TD M1(b)) |
| `CategoryTreatment` | `{ code, kind: 'rated' | 'free', rate, labelKey }`; `free` has rate 0 and is shown as "free of tax" on documents (brief s5: a GST-free line is marked). Kinds are a closed list; names and labels are configuration |
| `PriceBasis` | `inclusive` or `exclusive`: whether an amount handed to `tax` already contains the tax. Carried per line from `pricing`'s record flag (PRC 4.5), never assumed from the Market |
| `LineTax` | Result per line or charge: `gross`, `tax`, `net` (all `Money`, `gross = net + tax`), category code, treatment (`rated`, `free` or `seller-not-registered`), rate, `sellerRegistered`, registration period id, rule set id. Treatment `seller-not-registered` ⇔ `sellerRegistered = false`, and its rate is `"0"`, as for `free` (TD M1(a)); `rated` always has a rate > 0. These are the backstop CHECKs of TD 10.1.1 |
| `TaxStrategy` | The extension point of ADR-0001 decision 1 and ADR-0002 decision 3, declared in `tax/domain` (as `PricingStrategy`, PRC 2.2, Ali A3): `computeLines(ruleSet, lines, registrations) → LineTax[]`. Pure and synchronous: no I/O, no clock |
| `ConfiguredRateStrategy` | The single implementation (code `configured-rate`): one rate per category, per-line rounding, inclusive or exclusive basis. **AU GST is this strategy with AU's configuration**, and so is the synthetic Market ZZ and, later, NZ (P2). There is no AU class and no AU branch |
| `TaxStrategyRegistry` | Map from strategy code to implementation, filled at boot. An unknown code in a Market's rule set fails boot |
| `TaxRuleSetProvider` | `ruleSetAt(market, instant)` → the rule set in effect, or `tax.rule-set-unavailable`. Loaded and validated once at boot for every hosted Market (PRC 4.6 A2 pattern) |
| `UnitShareAllocator` | Pure: splits a line's frozen tax into per-unit shares with `allocateMoney(tax, [1, 1, …])` (quantity weights; largest remainder, ties to the earlier unit). The share of the k-th invoiced (or refunded) unit is fixed by the snapshot alone, so partial documents need no stored state and always sum to the line (4.6, 4.8) |
| `CumulativeAmountAllocator` | Pure, for amount-based parts only (the shipping charge and a commission reversal; Ali G2 T7): `round(tax × cumulativeAfter / gross) − round(tax × cumulativeBefore / gross)`; telescopes to the exact total when the whole amount is used (4.8, 4.9; T2). Never used for quantity splits |
| `DocumentPolicy` | Per rule set: document kinds (closed list of neutral codes, 4.6), required fields per kind (closed list of field codes), `taxDocumentMandatoryAbove` (AU $82.50) and `buyerIdentityFrom` (AU $1,000) as `Money`, label keys |

### 2.3 Modelling choices that need a reason
| Choice | Reason | Cost |
|---|---|---|
| No tables for slices 1 to 5 | Every answer is a pure function of (input, rule set, seller registration, seller zone). The callers freeze the answer (ADR-0007 decision 8; ordering brief s5 "Snapshot"). Storing quotes in `tax` would create a second copy that can disagree with the snapshot | Re-deriving a past answer needs the frozen rule set id; hence the pin test (13) |
| Tax configuration as effective-dated **code** (`config/markets/<code>.json`, section `tax`) | Ali's ruling (review-ali A6; brief s6 conflict 5): ADR-0003 decision 5 and ADR-0007 decision 9; ADR-0009 V2 dating is kept inside the file (`validFrom` per rule set); ADR-0026 decision 6 and 9 keep tax values out of the editable store | A rate change needs a release, prepared before its `validFrom` |
| One `ConfiguredRateStrategy` for all simple Markets | ADR-0002 decision 3, INTL-30: AU and NZ are "the same pattern, different rate and registry". A subclass per country would be the `if (country)` the CLAUDE.md forbids, in another form | A Market with rules this strategy cannot express (MY SST, EU, US) needs another implementation or an adapter (14) |
| `tax` does not read `catalog` (T1 option B, ruled by Ali G2) | `ordering` already reads the published revision id and tax category in one `productsForOrder` read (catalog O-1) and freezes both; a second read by `tax` could see a later revision (an admin override in between) and freeze a category of another revision. `ordering` passes the revision id with the code and `tax` echoes it in the answer, so the frozen pair is visibly one read | `tax` trusts its in-process caller for the category code; it still refuses a code that is not in the rule set (4.2). Tax brief s6 change-log row |
| `tax` reads the seller's registration itself | The meaning of the profile is `tax`'s (review-ali A6), and `ordering` must not decide who charges GST | One batched `sellers` call per calculation (6.1, ST1) |
| `tax` never sees a tax number | It needs only "registered or not, from when". At placement `ordering` freezes only the registered flag and the period id from `tax`'s answer, never the number (Ali G2 item 2). The seller's ABN and legal identity go onto the invoice **at issue time** through `ordering`'s own `sellers.taxProfileOf` and invoice-identity reads (S-3), stored encrypted on the invoice; the platform's number comes from `MarketConfig.legalEntity` | Two readers of the profile, each for its own purpose |

## 3. Lifecycle

### 3.1 Rule sets
A rule set is written in a PR, reviewed by Hassan when a rate, threshold or treatment changes (brief s9 item 1), and becomes effective at its `validFrom`. There is no state machine: "scheduled" is `validFrom > now`, "in effect" is the latest with `validFrom ≤ now`, "superseded" is any earlier one. Forbidden: editing a rule set whose `validFrom` has passed (the pin test fails CI); deleting one; a gap or overlap (by construction there is none: each runs until the next one's `validFrom`).

**Tamper controls (Hassan H3, accepted):**
- A checked-in **golden list** per Market holds, for every rule set, its id, `validFrom` and the pinned digest (SHA-256 of its canonical JSON). The list is **append-only**: CI refuses a change that edits or removes an existing entry.
- **Boot refuses** a rule set whose `validFrom` has passed (it is "started") unless its id and digest are on the golden list; the error names Market, rule set id and path only.
- **CI refuses a new rule set whose `validFrom` is already in the past** at merge time (a rate cannot be back-dated by a late PR).
- **CODEOWNERS** covers the `tax` section of every `config/markets/*.json` file and the golden list; a change needs Hassan's sign-off recorded in the PR (agents have no repository identity, so the entry names the owner account, as for the ADR-0030 raw-read list). This CODEOWNERS change is its own board-announced shared-file PR. Hassan checks H3 at code time.

### 3.2 Threshold alert (slice 6, P1)
| From → to | Trigger and guard | Effects |
|---|---|---|
| (none) → `OPEN` | Job (11): seller not registered at evaluation instant, trailing 12-month platform sales ≥ threshold × warning ratio, no open alert | Event `tax.registration-threshold-approached.v1`; audit (system actor) |
| `OPEN` → `CLEARED` | Job: trailing total fell below the **clear ratio** (cause `below-ratio`), or the seller is now registered (cause `seller-registered`; job or the `sellers` event, 6.4) | Audit; no event (nothing to tell) |

An alert decides nothing and never blocks selling (ADR-0007 decision 6; brief s5).

**Personal data (Hassan H5, accepted):** a sole trader's platform turnover is personal information (INTL-52). The alert row's trailing total is kept only for the AG-12 retention period after the alert clears, then a purge job (11) removes the row; the audit rows carry no turnover figure (8).

## 4. Tax rules

### 4.1 Where the values live (Ali A2 rule, PRC 4.6)
- **Platform `MarketConfig`** (read by more than one module): `pricesIncludeTax` (exists), currency (exists), `catalog.taxCategories` codes and label keys (exist, owned by `catalog`'s section), and the new `legalEntity` (4.9; read by `tax`, `commission-payouts` and `payments`). A shared-file PR adds `legalEntity` and reserves the `tax` section key (13, prerequisites).
- **`tax`'s own per-Market policy:** the `tax` section of the Market file, validated by `tax`'s schema at boot, with no default (fail closed), by the same mechanism as `pricing`'s policy loader (PRC 18).
- No `if (market == 'AU')`, no rate, threshold or currency constant in `modules/tax` (ADR-0003 decision 9; `pnpm boundaries` and a contracts test that greps the module for Market codes).

### 4.2 Category treatment
- Each category code of `catalog.taxCategories` has exactly one treatment in every rule set; boot fails when a code is missing on either side (T4: `catalog` keeps the list it already owns; `tax` adds the meaning).
- AU (working assumption, ADR-0007 decision 5): `taxable` → rated 0.10; `gst_free` → free. ZZ: `zz_standard` 0.15, `zz_reduced` 0.05, `zz_zero` free.
- An input category code unknown to the rule set → `tax.unknown-tax-category` for the whole call (fail closed).

### 4.3 Per-line computation (`ConfiguredRateStrategy`)
For a line: `amount` = unit price × quantity − allocated discount (discount is 0 until `promotions`, brief s3; the field exists so the interface does not change).
- Seller **not registered** at the evaluation instant: treatment `seller-not-registered`, rate `"0"`, `tax = 0`, `net = gross = amount` (ADR-0007 decision 6; TD M1). Treatment `free` (seller registered): rate `"0"`, the same amounts. Both are marked on documents (4.6).
- Registered and `rated`, basis **inclusive**: `tax = round_half_up(amount × r / (1 + r))`, computed as `scaleMoney(amount, n, 10^k + n)`; `net = amount − tax`; `gross = amount` (ADR-0007 decision 4).
- Registered and `rated`, basis **exclusive** (ZZ, and any Market with `pricesIncludeTax = false`): `tax = round_half_up(amount × r)`; `net = amount`; `gross = amount + tax`.
- Rounding per line (ADR-0007 decision 4 and Alternatives); a document's tax is the sum of its lines' tax, never rounded again (brief s5).
- Base rule (ordering-data X3, confirmed): with `configured-rate`, an inclusive line has `gross = amount` and an exclusive one `net = amount`, and an untaxed line has both. While `discount` is 0 (until `promotions`), `amount` is the line total, so `ordering`'s base CHECK holds; it must include the discount when promotions arrive (14).
- Every amount must be in the Market currency (`tax.currency-mismatch`); amounts are non-negative and at most 2^53 − 1 minor units (`tax.amount-out-of-range`); quantity is a positive integer up to the Market's `maxLineQuantity` (`tax.invalid-quantity`).

Worked AU examples (they join the agent's fixed set, 13.3): $11.00 → GST $1.00; $10.05 → $0.9136 → $0.91; $10.10 → $0.9182 → $0.92 (AC 2). An exact half minor unit cannot occur at 1/11 extraction; ZZ shows it: ¥10 at 15% exclusive → ¥1.5 → ¥2, and ¥10 at 5% → ¥0.5 → ¥1 (AC 2).

### 4.4 Which registration counts
- At checkout: the seller's registration in effect at the calculation instant (`Clock.now()` of `tax`; the caller supplies no instant, Ali G2 T7), read through `sellers` (ST1, 6.1). The answer carries `sellerRegistered` and the registration period id; `ordering` freezes both and nothing else of the registration (no number, Ali G2 item 2).
- `registrationPeriodId` (ordering-data X2): always present when `sellerRegistered = true`; present when the period containing the instant records "not registered"; `null` only when the seller has no period at that instant, which counts as not registered. So the backstop `NOT registered OR period IS NOT NULL` holds. The id is **opaque** (Hassan H1): callers store and echo it, never parse it or derive anything from it, and it carries no number or name.
- Later documents follow the **frozen** treatment, not today's profile: an order placed while the seller was not registered never shows GST, and one placed while registered keeps its GST (4.6). The straddling case (registration starts between order and invoice) is agent item AG-9; this rule is the working assumption.
- A `sellers` error or timeout → `tax.seller-registration-unavailable`; `ordering` refuses the order (ordering brief s5: fail closed).

### 4.5 Flat shipping fee (Q11; frozen working assumption, Ali ruling 6)
- Each seller sub-order's flat fee (owned by `sellers`, `sellerSummaries.flatShippingFee`, Ali ruling 7) is passed by `ordering` as a **charge** of that seller, with the same price basis as the Market's prices.
- Treatment: the rule set's `charges.shipping.categoryCode` (AU and ZZ: the standard rated category), and it follows **that seller's** registration (ordering brief s5; Q11). An unregistered seller's fee carries no GST. The answer for a charge always names its category code (ordering-data X1: never null).
- Never in the commission base (Q7); `tax` does not know the commission base, it only returns `net` per line and per charge so `commission-payouts` can exclude charges.
- Status: working assumption pending the agent (AG-5). If the agent rejects it, only the rule set's `charges` treatment and slice 2's tests change (mini-review; Stripe test mode only until then).

### 4.6 Documents (slice 3, gated)
`tax` decides the kind and the content rule of each customer document; `ordering` owns the record, number, storage and display (review-ali A6; brief s6).

| Neutral kind code | When | AU label key (configuration) |
|---|---|---|
| `tax-document` | The frozen treatment of every line on it has `sellerRegistered = true` | "Tax invoice" |
| `plain-document` | The frozen treatment says not registered | "Invoice" (never "Tax invoice", never a tax amount; AC 5) |
| `tax-adjustment-document` | Refund of a line frozen as registered | "Adjustment note" (AG-3) |
| `plain-adjustment-document` | Refund of a line frozen as not registered | "Refund note" |

- **One document = one registration state.** Lines of one seller sub-order share the seller and the order instant, so their frozen state is the same; a mixed request is refused (`tax.document-mixed-registration`), as a defence.
- **Required fields** come from the rule set as codes, never from code: `seller-legal-name`, `seller-tax-number`, `issue-date`, `item-description`, `item-quantity`, `item-price`, `tax-amount-or-inclusive-statement`, `taxable-extent-per-line` (a `free` line is marked), and `buyer-identity-or-tax-number` when the document total (gross) ≥ `buyerIdentityFrom` (AC 6). AU values per ADR-0007 Context; ZZ uses other thresholds, so a threshold change in ZZ changes behaviour without code (AC 6).
- **Under the mandatory threshold:** the answer carries `taxDocumentMandatory: false` when the total ≤ `taxDocumentMandatoryAbove`. Working assumption: `ordering` still issues the tax document for a registered seller (it is always on the order page, Q10), so the flag is informational; agent item AG-6.
- **Issue date (Ali G2 T7):** `ordering` sends `issuedAt`, the instant it will record on the invoice; `tax` accepts it only within `[now − 5 minutes, now]` of its own `Clock` (otherwise `tax.at-out-of-range`). The date is the local calendar date of `issuedAt` in the seller's **approved** zone, which `tax` always reads itself from `sellers` (`approvedSellerZones`, SEL 7.1a; ADR-0005 decisions 3 and 5); the zone is never an input. No approved zone → `tax.seller-zone-unavailable`; never the Market zone (as PRC 4.3). The answer returns the zone with the date, and **`ordering` stores the zone `tax` returns** on the document, not its own placement-time snapshot of the seller zone (Ali G2 tax verdict, 4.6).
- **Partial invoices (ORD-05):** for each line `ordering` sends the frozen `LineTax`, the ordered quantity, the quantity already invoiced and the quantity on this document. `tax` returns this document's tax per line as the sum of the unit shares at positions `[alreadyInvoiced, alreadyInvoiced + quantity)` (`UnitShareAllocator`, per-unit largest remainder; Ali G2 T7). The shares of all positions sum to the frozen line tax, so all invoices of a line sum to it exactly (AC 9). `ordering` stores the position range per document line, and its database refuses two documents covering one position (ordering-data F8, the EXCLUDE). `tax` never reads a current price or rate (ADR-0007 decision 8). Quantities beyond the ordered quantity → `tax.allocation-out-of-range`. Example (13.3): 3 × $3.35 = $10.05, GST $0.91 → unit shares 31, 30, 30 cents; invoicing 1, then 2 gives $0.31 and $0.60.
- **The flat shipping fee on a document** is an amount-based part: `ordering` sends the frozen charge answer and the cumulative gross of the charge already on earlier documents and after this one; `tax` uses `CumulativeAmountAllocator`. Working assumption: the first invoice of a sub-order carries the whole fee (AG-16), so this is `[0, fee gross)` once.
- The answer carries `net`, `tax`, `gross` per document line and totals, so `ordering`'s invoiced event gives `commission-payouts` the net (COM-05) without a second computation.

### 4.7 Configuration validation at boot (fail closed)
For every hosted Market: a `tax` section exists; strategy code registered; at least one rule set; ids unique; `validFrom` strictly increasing; rates parse as exact decimals in [0, 1], with `rated` > 0 and `free` = 0; warning ratio in (0, 1] and clear ratio in (0, warning ratio] (4.10); every Money in the Market currency; category codes equal `catalog.taxCategories`; `charges.shipping.categoryCode` and `commission.categoryCode` exist; rounding `half-up` and `line`; document fields from the closed list; `legalEntity` present in `MarketConfig` (its registration list may be empty, 4.9). Any failure stops boot with the Market, rule set id and path (ids and codes only).

### 4.8 Refund and adjustment reversal (slice 4, gated; ADR-0007 decision 11)
- `ordering` computes the refund money (largest remainder from its snapshot, review-ali A5) and locks the quantity; `tax` computes the tax reversed and the adjustment document's kind and content (ordering brief s5).
- Lines: the reversed tax of refunding `q` units is the sum of the unit shares at positions `[alreadyRefunded, alreadyRefunded + q)` of the same per-unit split (4.6). Refunding every unit reverses exactly the line tax. Never recomputed from a current price or rate (AC 10).
- Shipping charge (amount-based): `CumulativeAmountAllocator` on the refunded gross of the charge (T2); refunding the whole charge reverses exactly its tax. `ordering` sends the cumulative refunded gross of the charge before and after this request (it computes the fee share itself, ordering 4.8).
- `ordering` issues the adjustment document when the refund succeeds (ordering-data F12), so `tax` is called then, before that unit; the inputs are frozen values only, so the answer does not depend on when it is asked, except for the issue date.
- The adjustment document's kind follows the frozen treatment (4.6 table), its date is the local date in the seller's approved zone, and its required fields come from the rule set (AG-3).
- Who bears the refund (seller or platform, Q6) changes nothing here: the customer-facing tax reversal is the same; the ledger split is `commission-payouts`'.

### 4.9 GST on commission (slice 5, gated; Q1, Q7)
- Commission is a separate supply from `Market.legal_entity` to the seller (ADR-0007 decision 7). `commission-payouts` computes the commission amount (15% default, on the line's `net` after discount, excluding charges; Q7) and asks `tax` for the tax on it.
- `MarketConfig.legalEntity` (platform, A2 rule): `{ legalName, taxScheme, taxNumber | null, indirectTaxRegistration: [{ validFrom, registered }] }`, effective-dated like a rule set. **The entity's status is unknown today** (Q1: the agent decides): the list may be empty. Then `commissionTax` answers `tax.legal-entity-registration-unknown` and `commission-payouts` posts no commission-tax entry and pays out nothing that depends on it (fail closed; there is no safe default in either direction: charging GST without registration and not charging it while registered are both wrong).
- Registered at the supply instant: `tax = round_half_up(commission × r)` with the rule set's `commission.categoryCode` rate, **exclusive** basis (the commission is a net figure; the seller formula is "net invoiced − commission − GST on commission", commission-payouts brief s5). Not registered: `tax = 0` and `supplierRegistered = false`; PAY-09's tax statement is then not required (brief s3).
- Rounding per commission entry (one entry per invoiced line, as the ledger posts them); agent item AG-4.
- The supply instant `at` is the **`issuedAt` of the immutable invoice** (Hassan H2), which `commission-payouts` reads through `ordering.financialFactsOf` and passes as the system caller (6.2); never the event's `occurred_at` or a handler's clock. `tax` rejects an `at` later than now or earlier than the first rule set (`tax.at-out-of-range`).
- AC 11 and AC 12: commission on an $11.00 line (GST $1.00, net $10.00) at 15% = $1.50; GST on it $0.15 when registered, $0 when not; ZZ depends only on its configuration.
- **Reversal of commission GST (TD M4, accepted).** When `commission-payouts` reverses commission for a refund (proportional, Ali r5), the GST reversed is computed **from the original entry's frozen values only**, never by calling `commissionTax` again with a new `at` (a rate or registration change in between would reverse a different amount than was charged; the rule of 4.8 applied to commission). `reverseCommissionTax` (6.2, system only) takes the frozen entry (`ruleSetId`, rate, `supplierRegistered`, original commission, original commission tax) and the cumulative commission reversed before and after this reversal, and returns this reversal's tax by `CumulativeAmountAllocator`; it reads no rule set, no registration and no clock. The original values come **only from `commission-payouts`' stored entry**, never from a recomputation (Hassan H7). `tax` validates every entry and refuses the whole call: `0 ≤ reversedBefore ≤ reversedAfter ≤ original commission` (`tax.allocation-out-of-range`), and all amounts in the Market currency and equal to the original entry's currency (`tax.currency-mismatch`). Reversing all of the commission reverses exactly its tax. `commission-payouts` stores the reversal with a reference to the original entry (PD8). `ordering`, `payments` and `commission-payouts` still compute no GST themselves.

### 4.10 Registration-threshold warning (slice 6, P1)
- Applies only to sellers not registered at evaluation time. Trailing total = sum of the seller's platform supplies (net of refunds) over the 12 months ending at the seller's local today (365 local days; AG-10 for the exact period), in the Market currency. Threshold and warning ratio from the rule set (AU $75,000 and a ratio such as 0.8; the ratio is a team default the owner can change in code).
- A refund (adjustment document) counts at its own issue instant, not at the original invoice's, so the window is a plain range on each document table (TD M2(c); working assumption under AG-10).
- **Windows are per seller zone** (TD M2(a)). `turnoverOf` keeps one window per call; the job groups each batch of sellers by approved zone and calls once per distinct window (a Market has a handful of zones).
- **Which sellers are evaluated** (TD M2(b)): the sellers with any invoice or adjustment document in the window, listed by `ordering` through the same port (`SellerTurnoverSource.sellersWithSupplies`, keyset, 6.4), plus every seller with an open alert (so an alert can clear). A seller with no supply cannot cross the threshold, so the approved-seller list of `sellers` is not needed. This adds a method to the TX-4 port: **approved by Ali (T8, 2026-10-08)**: `sellersWithSupplies(ctx, from, to, after, limit ≤ 100)`, implemented by `ordering`; Mojtaba confirms its plan on the M8 index. The job is slice 6 (P1), so it blocks nothing before launch.
- **Clear ratio (TD M3, optional hysteresis):** an alert clears when the total falls below `clearRatio` (rule set, ≤ warning ratio). Default `clearRatio = warningRatio`, which is the behaviour above (no hysteresis; Ali 2026-10-08: Hadi's call, default no hysteresis). Whether AU sets a lower value (for example ratio − 0.05) against flapping alerts is a product rule for Hadi; not blocking.
- Wording says "sales on this platform only" (brief s7 team default); `tax` stores only the code, Jafar writes the text.
- The trailing total is read through `SellerTurnoverSource` (T3 option D, ruled by Ali G2; 6.4), implemented by `ordering` from its invoices and adjustment documents, which exist from day one (brief s3: data stored from day one); no backfill. "Data from day one" therefore depends on `ordering` keeping every document with seller, issue instant, net and currency for at least the window plus the AG-12 retention, which its legal-document rules already require (tax brief change-log row with T3).

## 5. Authorisation (ADR-0018, PF 6)

### 5.1 Permission catalogue (`modules/tax/contracts/permissions.ts`)
Declared with the platform helper and registered at boot with `registerPermissions('tax', TAX_PERMISSIONS)` in `TaxModule` (as `identity` and `sellers` do). Slices 1 to 5 add no key (their use cases are `anonymous` or `system`); the call lands with slice 1 if the helper accepts an empty list, otherwise with slice 6.

| Key | Scope | Protected | Allows | Slice |
|---|---|---|---|---|
| `tax.own-threshold.view` | seller | no | See the seller's own threshold status and open alert | 6 (P1) |
| `tax.seller-threshold.view` | platform | no | See any seller's threshold status and the open alerts of the admin's Market | 6 (P1) |

No key edits anything: tax configuration is code (4.1), category overrides are `catalog.tax-category.override` (CAT 4.3), and the seller's registration is `sellers`' (SEL-27). Default roles (identity ID 5.6, R10): Seller Owner and Store Manager get `tax.own-threshold.view`; the admin Finance or Platform Administrator role gets `tax.seller-threshold.view`. **Viewer does not get it by default** (Hassan H5: the view shows a sole trader's turnover, which is personal information); a custom role may grant it. Owner informed at slice 6 (Q5 pattern of pricing).

### 5.2 Use cases
| Use case | Access rule | Seller not approved | Ownership / Market |
|---|---|---|---|
| `tax.calculate-order-tax` | `anonymous` (checkout runs as the customer) | — | Market from context; seller ids are input and only select registration rows of the context's Market (an unknown or other-Market seller → `tax.seller-registration-unavailable`) |
| `tax.calculate-order-tax-for-system` | `system` | — | Market from the envelope |
| `tax.decide-invoice-document`, `tax.decide-invoice-document-for-system` | `anonymous` / `system` pair (the invoice is a seller action in `ordering`, which checks sub-order ownership before calling) | — | As above. Returns no personal data |
| `tax.reverse-refund-tax`, `…-for-system` | `anonymous` / `system` pair (RET-06 is an admin action in `ordering`) | — | As above |
| `tax.commission-tax` | `system` (`commission-payouts` handlers) | — | Market from the envelope; `at` accepted only here (4.9) |
| `tax.reverse-commission-tax` | `system` (`commission-payouts` handlers) | — | Market from the envelope; frozen values only, no instant (4.9) |
| `tax.view-own-threshold-status` (slice 6) | `permissions: [tax.own-threshold.view]` | deny | The seller from `ActorContext.sellerId` only; no seller id in input |
| `tax.view-seller-threshold-status`, `tax.list-threshold-alerts` (slice 6) | `permissions: [tax.seller-threshold.view]` | — | Seller id looked up in the context's Market only; unknown and other-Market ids answer byte-identically |
| `tax.evaluate-registration-thresholds` (slice 6 job) | `system` | — | Per hosted Market |

- The `anonymous` and `system` pairs follow PRC 6.2 and `sellers.sellerSummaries`: two use cases behind one facade method, chosen by actor kind. Every non-permission rule goes on the checked-in list (PF 6.2 row 5); Hassan reviewed the list (H1, accepted with the conditions below).
- `anonymous` is acceptable because the answers hold no personal data (a registration yes/no, rates, codes and amounts the caller sent). No facade method is exposed over HTTP (6.2). **Accepted by Hassan (H1) under three conditions:** (a) a named boundary rule in `pnpm boundaries`: only `modules/ordering` and `modules/commission-payouts` import `TaxFacade`, with a fixture that fails for any other importer; (b) a test proves that no HTTP route and no AI tool declaration reaches any `tax` facade method (the route-reachability check of the anonymous/system pairs); (c) `registrationPeriodId` is opaque (4.4).
- **System-only list (Hassan H6, accepted):** `commissionTax`, `reverseCommissionTax`, both `SellerTurnoverSource` methods (`turnoverOf`, `sellersWithSupplies`) and `ordering.financialFactsOf` are on the checked-in `system`-only list (PF 6.2 row 5). None of them is an entry of the elevation allow-list of ADR-0038 (ADR-0038 draft): no request actor reaches them, even elevated.
- Acting-as (SEL-08): `tax` writes nothing on a user's behalf; the two slice 6 views are reads and are allowed in an acting-as session (audit rows of the caller carry `acting_as_id`).

### 5.3 Answer codes
`tax.currency-mismatch`, `tax.amount-out-of-range`, `tax.invalid-quantity`, `tax.unknown-tax-category`, `tax.rule-set-unavailable`, `tax.seller-registration-unavailable`, `tax.seller-zone-unavailable`, `tax.document-mixed-registration`, `tax.allocation-out-of-range`, `tax.legal-entity-registration-unknown`, `tax.at-out-of-range`, `tax.batch.too-large`; platform codes `validation.failed`, `conflict.retry`. Every error refuses the whole call: `tax` never answers a batch in part.

## 6. Boundary

`tax` imports only `contracts/` of `sellers` (and `identity` through the gate), plus the kernel and `platform/`. It imports neither `catalog` (T1), nor `ordering`, `commission-payouts` or `payments`. `ordering` and `commission-payouts` import `tax`; `sellers` does not, so there is no cycle (the slice 6 turnover port keeps the direction `ordering → tax`, T3). No module reads `tax`'s tables. The one port `tax` declares (`SellerTurnoverSource`, slice 6) is implemented by `ordering`, so the import direction stays `ordering → tax`.

### 6.1 What `tax` needs from others
| # | From | Need |
|---|---|---|
| ST1 | `sellers` (**new or changed facade; sellers mini-review**) | `taxRegistrationOf(ctx, sellerIds, at)`: 1 to 100 ids, `anonymous` and `system` pair, in-process → per id `{ registered: boolean, periodId, validFrom }` of the period containing `at`, or absent for an unknown, other-Market or no-approved-revision seller. **No scheme number** (not personal data). Hassan H4 (accepted): a contracts snapshot test asserts that the ST1 answer type has no number field, and no `tax` or `ordering` log line carries a tax number (log redaction test). Today SEL 7.1 has only `taxProfileOf(ctx, sellerId, at)`, single id, `system`, with the number: it stays for `ordering`, which the brief and ordering brief s6 ask to make a batch (`sellerIds`). Advisory read (ADR-0025 decision 1) |
| ST2 | `sellers` (exists, SEL 7.1a) | `approvedSellerZones(ctx, sellerIds)` for issue dates (4.6, 4.8) and the slice 6 local days |
| PL1 | `platform` (**shared-file PR**) | `MarketConfig.legalEntity` (4.9) and the reserved `tax` section key; `Clock`, `MarketContextFactory`, permission registry, gate; from slice 6: UnitOfWork, outbox, inbox, scheduler, audit writer |
| — | `catalog` | Nothing (T1). `catalog.taxCategories` is read from `MarketConfig` at boot only (4.2) |

### 6.2 Public facade (`modules/tax/contracts/tax.facade.ts`)
```ts
interface TaxFacade {
  // slice 2; 1..200 lines + 0..100 charges, 1..100 distinct sellers
  calculateOrderTax(ctx: CallContext, req: OrderTaxRequest): Promise<Result<OrderTaxAnswer, TaxError>>;
  // slice 3 (gated)
  decideInvoiceDocument(ctx: CallContext, req: DocumentRequest): Promise<Result<DocumentAnswer, TaxError>>;
  // slice 4 (gated)
  reverseRefundTax(ctx: CallContext, req: RefundTaxRequest): Promise<Result<AdjustmentAnswer, TaxError>>;
  // slice 5 (gated); system only
  commissionTax(ctx: CallContext, req: CommissionTaxRequest): Promise<Result<CommissionTaxAnswer, TaxError>>;
  // slice 5 (gated); system only; frozen values in, no rule set, no clock (4.9, TD M4)
  reverseCommissionTax(ctx: CallContext, req: CommissionReversalRequest): Promise<Result<CommissionReversalAnswer, TaxError>>;
}
type TaxLineInput = { ref: string; sellerId: Id<'Seller'>; taxCategoryCode: string;
  catalogRevisionId: Id<'ProductRevision'> /* echoed, never read (T1 B, T7) */;
  unitPrice: Money; priceBasis: 'inclusive' | 'exclusive'; quantity: number; discount: Money };
type ChargeInput = { ref: string; sellerId: Id<'Seller'>; kind: 'shipping'; amount: Money;
  priceBasis: 'inclusive' | 'exclusive' };
type LineTaxAnswer = { ref: string; gross: Money; tax: Money; net: Money;
  taxCategoryCode: string /* never null, also for a charge */; catalogRevisionId: Id | null /* null for a charge */;
  treatment: 'rated' | 'free' | 'seller-not-registered';
  rate: string /* exact decimal; "0" unless rated */; sellerRegistered: boolean; registrationPeriodId: string | null;
  ruleSetId: string; strategyCode: string; evaluatedAt: Instant };
type OrderTaxAnswer = { ruleSetId: string; strategyCode: string; evaluatedAt: Instant;
  lines: LineTaxAnswer[]; charges: LineTaxAnswer[];
  bySeller: { sellerId: Id<'Seller'>; gross: Money; tax: Money; net: Money }[];
  total: { gross: Money; tax: Money; net: Money } };
```
- **`LineTaxAnswer` is the unit `ordering` freezes** (its `TaxBreakdown`, Ali G2 item 1): amounts, category code, treatment, rate, registration flag and period id, and the rule set id, strategy code and evaluation instant repeated on each line so a frozen line is self-describing. No `configVersion`, no `taxable` flag.
- `ref` is the caller's opaque key (≤ 64 characters), echoed back; `tax` stores nothing about orders.
- **Inputs `tax` never takes (Ali G2 T7 and item 3):** no checkout instant ("now" is `tax`'s `Clock`), no seller zone (read from `sellers`), no delivery-address region. The only instants accepted are `issuedAt` for documents and refunds, bounded to `[now − 5 minutes, now]` (4.6), and `at` for `commissionTax` (4.9).
- `DocumentRequest` carries `issuedAt` and, per line, the frozen `LineTaxAnswer`, ordered quantity, already invoiced (or refunded) quantity and this document's quantity, and per charge the frozen answer with the cumulative gross before and after this document; `DocumentAnswer` returns `kind`, `labelKey`, `issueDate` + `zone`, `requiredFields`, `taxDocumentMandatory`, `buyerIdentityRequired`, per line and total `{gross, tax, net}`, and per line the treatment marker. `RefundTaxRequest`/`AdjustmentAnswer` are the same shape for refunds plus charge reversals (4.8).
- `CommissionTaxRequest = { at, entries: { ref, sellerId, commission: Money }[] }` (≤ 200) → per entry `{ tax, rate, supplierRegistered }` plus `ruleSetId`, `legalEntityRegistrationValidFrom`.
- `CommissionReversalRequest = { entries: { ref, original: { ruleSetId, rate, supplierRegistered, commission: Money, tax: Money }, reversedBefore: Money, reversedAfter: Money }[] }` (≤ 200) → per entry `{ tax }`. Refused when `reversedAfter` exceeds the original commission (`tax.allocation-out-of-range`).
- Limits above are refused whole with `tax.batch.too-large` (PRC 6.2, CAT L7). The brief's NFR (20 lines from 5 sellers in one batched call, no database read in the pure path) holds: one `sellers` call, no table.
- Wire format if ever exposed: amounts as strings of minor units (ADR-0007 decision 10). The facade is in-process only; no HTTP route serves it.
- Answers are deterministic for (input, rule set, registration, zone, date). They are advisory in the ADR-0025 sense: `ordering` freezes the rule set id, rate, treatment and registration period id with the amounts.

### 6.3 Events published (slice 6 only; ids, enums and instants, PE 5.3)
| Type | Aggregate | Payload |
|---|---|---|
| `tax.registration-threshold-approached.v1` | threshold-alert | `sellerId`, `alertId`, `crossedAt` |

No amount and no actor in the payload; the panel reads amounts through the slice 6 views. Slices 1 to 5 publish nothing.

### 6.4 Events consumed and the slice 6 turnover source (T3)
Events are ids only (PE 5.3) and the vocabulary has no money kind (PRC 6.3), so `tax` cannot build a sales tally from `ordering`'s events without reading `ordering`, which would make `ordering ↔ tax` a cycle. **`tax` therefore consumes no `ordering` event.** **Ali ruled option D (G2, 2026-10-08)**; the other options are kept for the record:

| Option | How | For | Against |
|---|---|---|---|
| **D (ruled)** | `tax` declares a port in its `contracts/` (`system` only): `SellerTurnoverSource.turnoverOf(ctx, sellerIds ≤ 100, fromInstant, toInstant)` → per seller the net platform supplies (invoiced minus adjusted, Market currency), and `sellersWithSupplies(ctx, fromInstant, toInstant, after, limit ≤ 100)` → seller ids with any document in the window, keyset by seller id (4.10; TD M2(b); shape approved by Ali, T8). `ordering` implements it from its own documents and binds it at boot (the `CatalogReferences` pattern of ADR-0028 decision 9). The slice 6 job reads it in bounded batches | No cycle (`ordering` imports `tax` contracts only); no copy of sales data in `tax`; "data from day one" holds because `ordering` keeps every invoice; no backfill | The job depends on `ordering`'s read at run time (a failure skips the run and alerts; no sale is affected). Hassan accepted the system-only read of per-seller sales totals (15.3 H6) |
| A | One-way command `ordering → tax`: `tax.recordSellerSupply(system, { supplyId, sellerId, kind, net, occurredAt })` with stored intent, idempotent on `supplyId` (Ali ruling 8 pattern) | `tax` owns a tally, as brief s6 words it | `ordering` gains an outbound command and intent table; `tax` keeps a second copy of sales; a backfill is needed |
| B | Add a `money` kind to the event vocabulary and put the net on `ordering`'s events | Plain event consumption | Kernel change for every module, Hassan review, money in the outbox |
| C | The tally lives in `commission-payouts` (it already ledgers invoiced amounts) and calls a pure `tax` threshold rule | No new data path | Moves data the brief gives to `tax`; mixes ledger and tax advice |

`sellers.tax-registration-recorded.v1` (SEL 7.4, `sellerId` only) is consumed in slice 6 to clear an open alert at once when a seller registers; the job (11) also clears it, so the event only shortens the delay.

## 7. Data ownership (for Mojtaba)
`tax` owns no table in slices 1 to 5. From slice 6 it owns, in schema `tax`: the threshold alerts, `tax.inbox` and `tax.outbox`. It keeps no copy of sales (T3). Every row carries `market_id` and `tenant_id`; Money is `BigInt` + `char(3)`; indexes start with `market_id` (ADR-0003 decision 3, ADR-0004). It never stores a tax number, a name, an address or any customer data (brief s9 privacy).

| # | Input |
|---|---|
| PD1 | Confirmed by Mojtaba (TD 1): no `tax` schema or migration before slice 6. Slices 1 to 5 are code and configuration only |
| PD2 | No sales table in `tax` (T3 option D, ruled). TD 3.3 keeps option A's table design for a reversal only |
| PD3 | **For `ordering`'s data design:** the `SellerTurnoverSource.turnoverOf` read: net invoiced minus adjusted per seller over [from, to), up to 100 sellers per call, indexed from `market_id` (TD 10.1.3: covering index, measured); and the `sellersWithSupplies` keyset listing over the same window (T8; Mojtaba confirms its plan on the same index) |
| PD4 | Threshold alerts: at most one `OPEN` per (Market, seller) (partial unique index); `opened_at`, `cleared_at` write-once; trailing total and ratio at crossing |
| PD5 | Grants: `INSERT` and `SELECT` on PD4; `UPDATE` only on its clear columns; no `DELETE` (V4 history) except the PD6 purge of cleared rows |
| PD6 | Retention of alerts (Hassan H5): the trailing total of a sole trader is personal information. A cleared alert is purged after the AG-12 retention period by a job (11); an open alert is kept. `sellers`' purge (SEL 8.4) selects never-approved files only, which have no supplies and so no alert: nothing to purge in `tax` today and no cross-module call; erasure of an approved seller is follow-up F-T1 (a `tax` handler then, TD 9, 12.2). The purge is a table `DELETE` grant plus triggers that refuse deleting an open alert and any `TRUNCATE`, for every role (TD 3.2), which overrides PD5's "no `DELETE`" for cleared rows only |
| PD7 | **For `ordering`'s data design (owned there):** the snapshot columns that freeze a `LineTaxAnswer` per line and per charge: `tax_rule_set_id`, `tax_strategy_code`, `tax_category_code` (never null, also for a charge), `tax_treatment` (`rated`, `free`, `seller-not-registered`), `tax_rate numeric` (exact decimal, compared numerically), `gross`, `tax`, `net` (BigInt + currency), `seller_registered`, `registration_period_id`, `evaluated_at`, and the price basis sent (Ali D-1, 2026-10-08: **no `price_basis` column**; lines keep the existing `tax_inclusive`; `seller_order_charges` gains `tax_inclusive boolean NOT NULL`; the name `tax_price_basis` is used only if a text form is needed later); the backstop CHECKs of TD 10.1.1; per document: `kind`, `label_key`, `issued_at`, `issue_date` (date) + `issue_zone` (the zone `tax` returned), `required_fields`, `tax_document_mandatory`, `buyer_identity_required`, `tax_rule_set_id`; per document line the unit-position range, with an EXCLUDE so no position is invoiced twice or refunded twice (TD addition, accepted; ordering-data F8); per charge portion the cumulative range, with the same kind of EXCLUDE (TD 10.1.2, accepted) |
| PD8 | **For `commission-payouts`' data design:** the commission-tax entry freezes `tax_rule_set_id`, `tax_rate numeric`, `supplier_registered`, `legal_entity_registration_valid_from` (NOT NULL) and `tax_evaluated_at` with the amount (TD 10.2). A reversal entry references the original entry and stores the cumulative commission reversed, so `reverseCommissionTax` gets frozen values only (TD M4, 4.9) |

## 8. Audit (brief s9; IMP-10)
| Action | When | Before/after |
|---|---|---|
| (none in slices 1 to 5) | Pure reads write nothing. A rule set change is a reviewed PR (Hassan, brief s9) whose content is pinned (13); boot logs the active rule set id per Market | — |
| `tax.threshold-alert.opened`, `.cleared`, `.purged` | Slice 6 jobs, system actor, in the job's unit | Seller id, alert id, ratio, clear cause. **No trailing total** in the after-values (Hassan H5: a sole trader's turnover is personal information; audit rows are never deleted) |

Category overrides and registration changes are audited by their owners (`catalog`, `sellers`; brief s9).

## 9. Idempotency and concurrency
- **Facade reads:** deterministic; a retried call gives the same answer for the same rule set, registration and local date. `ordering` freezes the first answer it commits.
- **Clock and boundaries:** a call that straddles a rule set's `validFrom` uses the single instant it read at its start; the answer names the rule set, so a retry after the boundary is visibly different and `ordering` re-quotes (its "customer pays what they saw" rule, ordering brief s5).
- **Slice 6:** the alert job holds at most one `OPEN` alert per seller (PD4) and is safe to run twice or concurrently (PE 7).
- **Consumed events:** inbox `runOnce` (ADR-0006 decision 5).

## 10. Where each hard rule is enforced
| Rule (brief s5) | Enforcement point | Test |
|---|---|---|
| Money in minor units; rates exact; explicit half-up | `TaxRate` parser and `ConfiguredRateStrategy` via kernel `scaleMoney`; no `number` arithmetic on amounts (lint rule on `modules/tax/domain`) | AC 2, AC 14; property tests |
| Market currency only | Facade input validation and strategy guard against the Market's currency from `MarketRegistry` | AC 14 |
| Tax-inclusive extraction vs exclusive addition | `ConfiguredRateStrategy` from the per-line `priceBasis` | AC 1; ZZ fixture |
| Per-line rounding; document tax = sum of lines | Strategy and document assembly never round a total | AC 2 |
| Category mandatory, inherited, meaning per Market | `catalog` (field, revision, override); `tax`: boot equality of codes (4.7) and `tax.unknown-tax-category` | AC 3, AC 4 |
| Unregistered seller: no GST, plain document | Strategy (`seller-not-registered`) and document kind from the frozen flag | AC 5 |
| Document content and thresholds from configuration | `DocumentPolicy` per rule set | AC 6 |
| Issue date in the seller's approved zone | `decideInvoiceDocument` with `Clock` and ST2; no Market fallback | AC 8 |
| Partial documents sum exactly | `UnitShareAllocator` (largest remainder) | AC 9 |
| Refund from the snapshot, never today's rate | `reverseRefundTax` takes only frozen values; it never calls the rule set provider for amounts | AC 10 |
| Commission GST only when the entity is registered; unknown refuses | `commissionTax` from `MarketConfig.legalEntity` | AC 11, AC 12 |
| Commission GST reversed from the frozen entry, never re-evaluated | `reverseCommissionTax` takes only frozen values (4.9) | Property test: all reversals sum to the original tax |
| Shipping GST follows the seller | Strategy, charge treatment from the rule set | AC 13 |
| Frozen at order time | `ordering`'s snapshot (PD7); `tax` stores nothing | ordering's tests |
| No AU branch in core | One strategy; values only in `config/markets`; boundary and grep tests | AC 15 |
| `ordering`, `payments`, `commission-payouts` never compute GST | Only `tax` holds the strategy; a boundary rule forbids importing `tax/domain` (contracts only) and the review checklist forbids rate arithmetic elsewhere | Boundary fixtures |
| No model on the path | `tax` is not on the AI import allow-list (ADR-0019 R2) | `pnpm boundaries` |
| Ownership (seller A never sees B's status) | Slice 6 views (5.2) | AC 16 |

## 11. Jobs
`tax.evaluate-registration-thresholds` (slice 6, P1): daily per hosted Market; the run time relative to each seller's local midnight does not matter (the trailing window uses local days, evaluated at run time). Population (4.10): sellers listed by `SellerTurnoverSource.sellersWithSupplies` over the widest window of the run, plus sellers with an open alert. Per batch of up to 100 sellers: registrations through ST1, zones through ST2, then the sellers grouped by zone and one `turnoverOf` call per distinct window (TD M2(a)); a port failure skips the run and alerts. It opens or clears alerts (3.2), one unit per seller. Safe to run twice (PD4). Nothing is wrong if it does not run: no sale is blocked by an alert.

`tax.purge-threshold-alerts` (slice 6, P1; Hassan H5): daily per hosted Market; deletes cleared alerts older than the AG-12 retention period (a `tax` policy value with no core default until the agent answers AG-12; until then nothing is purged and the job logs that the period is unset). Writes `tax.threshold-alert.purged` (ids only). Bounded batches; safe to run twice.

## 12. AI (ADR-0019)
- None. Tax is a deterministic path (decision 10, R2): no model is called, no `tax` file is on the model allow-list, `tax` publishes no AI tool. No AI code is merged in Phase 5 (decision 8).
- AIS-04 (category suggestion, P2) stays in `catalog` and is a suggestion only (brief s3).

## 13. Slices, prerequisites and tests

### 13.1 Prerequisites
- Shared-file PR announced on the board: `MarketConfig.legalEntity` (AU with an empty registration list until the agent answers; ZZ with both states in fixtures) and the reserved `tax` section key (PL1). Slice 1.
- `sellers` mini-review: ST1 (`taxRegistrationOf`, batch, `anonymous`/`system`, no number) and the batch form of `taxProfileOf` for `ordering`. Slice 2.
- Kernel `Money`, `scaleMoney`, `allocateMoney`: exist.
- Identity permission registry (exists); outbox, inbox, scheduler and audit writer for slice 6.
- `ordering` G2 accepts the facade of 6.2 and PD7; `commission-payouts` G2 accepts `commissionTax` and PD8.
- **Agent's written confirmation** (ADR-0036): before any code of slices 3, 4 and 5 (and of `ordering`'s invoice and refund slices, `commission-payouts` 3 and 6, PAY-09); every item of the agent list, including AG-2 and AG-5 that slices 1 and 2 rely on, before Stripe live mode (ADR-0036 decision 7).

### 13.2 Order and reviews
As in 1.1. Every slice needs Hassan's review before merge (tier A; Q2(a) replaces the PLAYBOOK human review). Slice 2 runs in Stripe test mode only until the pen test and the agent pass (Ali ruling 6). If the agent rejects an assumption that slices 1 or 2 rely on (rounding level, shipping treatment, extraction formula), a mini-review changes the rule set and tests, not the interfaces.

### 13.3 Worked-example set (the agent's fixed set; owner Q2(a), Ali ruling 6)
A versioned, checked-in file per Market (`test/fixtures/tax/worked-examples/AU.json`, `ZZ.json`) that is both a test table and the document the agent signs. Each slice appends its cases; the agent's confirmation names the set's version and hash. Minimum AU content: $11.00, $10.05, $10.10 taxable; mixed basket (GST-free meat $25.00 + taxable snacks $5.50 → GST $0.50); unregistered seller; partial invoices of 3 × $3.35 (shares 31, 30, 30); flat shipping $9.90 → $0.90 for a registered seller, $0 otherwise; commission 15% on net $10.00 → $1.50, GST $0.15 or $0; reversal of a third of that commission ($0.50) → GST $0.05, then the rest → $0.10 (sums to $0.15); refund of 1 of 3 units; a $1,200 document needing buyer identity; an $80 document under the mandatory threshold.

### 13.4 Tests
- Every domain test runs against AU (`config/markets/AU.json`: AUD, exponent 2, inclusive, one rate 0.10, two categories, thresholds $82.50 and $1,000) and ZZ (`test/fixtures/markets/ZZ.json`: JPY, exponent 0, `pricesIncludeTax = false`, three categories at 0.15, 0.05 and free, other thresholds, locale ja-JP, seller zones Asia/Tokyo, Pacific/Auckland (DST) and Pacific/Chatham (+12:45, DST)). A test that passes only for AU is a bug (ADR-0003 decision 9).
- Property tests: inclusive `net + tax = gross`; exclusive `gross = net + tax`; per-unit shares sum to the line tax for every quantity up to `maxLineQuantity`; any sequence of partial invoices and refunds never exceeds the line and sums exactly when complete; cumulative shipping reversal sums exactly; the exact half minor unit rounds up (ZZ).
- Rule-set pin test: the hash of every rule set whose `validFrom` is in the past equals the checked-in golden list; boot validation cases of 4.7, each failing alone. H3 (3.1): an edited or removed golden-list entry fails CI; a started rule set missing from the golden list, or with another digest, stops boot; a new rule set with `validFrom` in the past fails CI.
- H1: `pnpm boundaries` fixture importing `TaxFacade` from a module other than `ordering` and `commission-payouts` fails; route-reachability check: no HTTP route or AI tool declaration reaches a `tax` facade method. H4: ST1 answer type has no number field (contracts snapshot); no log line holds a tax number. H5: audit after-values of the alert actions hold no turnover figure; purge of cleared alerts after the retention period, none while the period is unset. H7: `reverseCommissionTax` refuses `reversedBefore > reversedAfter`, `reversedAfter` above the original, and a currency other than the Market's or the original's.
- No Market literal and no numeric rate in `modules/tax` (grep test); no `number` arithmetic on amounts (lint).
- Seller registration: unregistered (treatment `seller-not-registered`, rate `"0"`), registered, a period recording "not registered", no period, registration starting after the order (snapshot rule, 4.4); `sellers` error → refusal.
- Rates compared numerically (`"0.10"` = `"0.1"`); `catalogRevisionId` echoed per line; `issuedAt` outside `[now − 5 min, now]` refused; no input field for a zone, a region or a checkout instant (contracts snapshot).
- Slice 6 job: sellers in two zones get two windows; a seller with an open alert and no supply is still evaluated and cleared; the clear ratio below the warning ratio keeps an alert open between the two.
- Issue dates at 23:30 UTC for Brisbane (+10), and on DST transition days for Auckland and Chatham (AC 8; ADR-0005 decision 8 fixtures).
- Commission: entity registered, not registered, unknown (refusal), and a registration change between two supplies (4.9).
- Facade: batch limits refused whole; `ref` echo; unknown category; mixed currency; ZZ thresholds change document fields without code.
- Contracts snapshot of facade types and the slice 6 event (no amount, no actor).
- Boundary fixtures: `tax` imports no `catalog`, `ordering`, `commission-payouts` or `payments`; nobody imports `tax/domain`.
- One test per AC of brief s10.

## 14. Deferred
| Item | When |
|---|---|
| NZ (same strategy, NZ configuration) | P2 (INTL-30) |
| MY SST, EU VAT/OSS, US sales tax, buyer tax id (INTL-31 to 34): another strategy or an external adapter behind a separate asynchronous port (ADR-0002 decision 5) | P3, no Market |
| Platform-funded discounts and coupons and their GST (CRT-06) | `promotions` P2; the `discount` input already exists (AG-7). `ordering`'s base CHECK (4.3) must then include the discount |
| Admin tax export, BAS figures | Out of Phase 5 (brief s3) |
| Partial shipping-charge refunds other than by amount | With `returns` (Phase 7), if needed |
| A Vertical override of category treatment | When a vertical needs it (`TaxRuleSetProvider` is the seam) |

## 15. Open questions

### 15.1 Owner, through Hadi
- None new. The entity's GST status is decided by the agent (Q1); the design carries both states and "unknown" refuses (4.9).
- Owner action (Ali G2 section 5): book the registered tax agent now; needed by about `ordering` slice 4. Until the agent answers, the AU legal entity's registration stays "unknown" and commission GST is refused.
- M3 (Hadi, not blocking): whether AU sets a clear ratio below the warning ratio (hysteresis, 4.10).

### 15.2 Ali (cto)
Ruled in Ali's G2 review (2026-10-08), applied in this revision:

| # | Question | Ruling |
|---|---|---|
| T1 | Who supplies the tax category | **B**: `ordering` passes the frozen code and revision id (echoed); tax brief s6 change-log row |
| T2 | Allocation methods | **Accepted**: per-unit largest remainder for quantity splits; cumulative allocation only for amount-based parts (the shipping charge; and the commission reversal, 4.9, which is the same method) |
| T3 | Slice 6 turnover source | **D**: `tax` declares `SellerTurnoverSource`, `ordering` implements it; `tax` consumes no `ordering` event; brief change-log row |
| T4 | Category list ownership | **Accepted**: `catalog` keeps codes and labels; `tax` adds treatments and checks equality at boot; brief change-log row |
| T5 | `MarketConfig.legalEntity` with dated registration | **Accepted**; shared-file PR (PL1) |
| T6 | ADR numbers | **0035** checkout Saga, **0036** tax-agent timing; both claimed on the board (rev 134) |
| T7 | Facade alignment with `ordering` | **Settled** (no joint mini-review): no checkout instant from input; `issuedAt` only in `[now − 5 min, now]`; zone always from `sellers`; `catalogRevisionId` echoed; per-unit largest remainder for quantity splits, cumulative allocation only for the shipping charge. `deliveryAddressRegion` dropped from the input (Ali G2 item 3). Both G2s edited to match (6.2; ordering TX-1, TX-2) |

Follow-up rulings (Ali, Ali G2 review 2026-10-08 section 6, 2026-10-08), applied:

| # | Question | Ruling |
|---|---|---|
| T8 | TX-4 port shape (TD M2(b)): population of the slice 6 job | **Approved**: `SellerTurnoverSource.sellersWithSupplies(ctx, from, to, after, limit ≤ 100)`, implemented by `ordering`; Mojtaba confirms the plan on the M8 index; P1 slice 6 (4.10) |
| T9 / D-1 | PD7 price-basis column | **Accepted as proposed**: no `price_basis` column; `tax_inclusive` stays on `order_lines`; `seller_order_charges` gains `tax_inclusive boolean NOT NULL`; `tax_price_basis` only if a text form is needed later. Mojtaba updates `docs/design/data/tax.md` 10.1.1 (PD7) |
| M3 | Clear ratio | Hadi's call; default no hysteresis (`clearRatio = warningRatio`) (4.10) |

### 15.3 Hassan (security-tester): answered 2026-10-08 (Hassan review 2026-10-08), applied
| # | Question | Answer | Where |
|---|---|---|---|
| H1 | `anonymous` on the computation facades | Accept, with a named boundary rule (only `ordering` and `commission-payouts` import `TaxFacade`), a test that no HTTP route or AI tool exposes it, and an opaque `registrationPeriodId` | 4.4, 5.2, 13.4 |
| H2 | Bounded instants | Accept; `commissionTax`'s `at` is the immutable invoice `issuedAt` | 4.9 |
| H3 | Rule-set tampering | Medium: append-only golden list with pinned digests; CODEOWNERS on the `tax` section and the golden list requiring Hassan; boot refuses a started rule set not on the list; CI refuses a new rule set with `validFrom` in the past. Checked at code time | 3.1, 13.4 |
| H4 | No number in ST1 | Accept; contracts test (no number field); the number is never logged | 6.1, 13.4 |
| H5 | Turnover as personal information | Medium: yes. Retention per AG-12, then a purge job; no trailing total in audit after-values; `tax.seller-threshold.view` not given to Viewer by default. Checked at code time | 3.2, 5.1, 8, 11, PD6 |
| H6 | System-only reads | Accept; both port methods and `financialFactsOf` on the `system`-only list | 5.2 |
| H7 | `reverseCommissionTax` | Accept; originals from C-P's stored entry; validate `before ≤ after` and currency | 4.9, 13.4 |

### 15.4 Agent list (written confirmation needed; brief s8, Ali review C, owner Q1 and Q2)
AG-1 issuing customer tax invoices on the seller's behalf (name and ABN); AG-2 per-line rounding; AG-3 adjustment-note content and kinds for refunds; AG-4 GST on commission, exclusive basis, per-entry rounding, and the entity's registration status; AG-5 GST on the per-seller flat shipping fee following the seller; AG-6 the $82.50 threshold per sub-order document and issuing a tax invoice below it; AG-7 platform-funded discounts and delivery (CRT-06); AG-8 buyer identity at $1,000; AG-9 the document kind when registration starts between order and invoice (snapshot rule, 4.4); AG-10 the 12-month period for the warning; AG-11 gap-free sequential invoice numbering (owned by `ordering`); AG-12 retention period of tax documents; AG-13 any product category needing special handling; AG-14 the "Order confirmation" email not being a tax invoice (Q10); AG-16 which invoice of a sub-order carries the flat shipping fee (ordering draft default: the first); AG-15 the worked-example set (13.3).

## 16. Follow-ups (none in this document's PR)
- ADR-0036 (accepted by Ali 2026-10-08, Hassan accepted with the tax G2; owner informed): move into `docs/adr/`, with an "Amended by ADR-0036" line on ADR-0007's status.
- Shared-file PR, announced on the board (Hassan H3): CODEOWNERS entries for the `tax` section of `config/markets/*.json` and the rule-set golden list.
- Tax brief change log through a mini-review signed by Hadi and Ali: T1 (no `catalog` dependency), T3 (turnover through the `ordering` port; "data from day one" held by `ordering`'s documents), T4 (category list stays in `catalog`), ST1, brief s5 line 69 fix (Ali G1 ruling 2).
- `sellers` mini-review (SMR thread; Hadi → Mohammad → Mojtaba → Hassan → Ali; before ordering and tax slice 2): ST1 `taxRegistrationOf` (batch, `anonymous`/`system` pair, no number), batch `taxProfileOf` (system), S-3 invoice identity as of an instant, S-2 `recordFirstSale`.
- Platform shared-file PR, announced on the board: `legalEntity`, reserved `tax` section (PL1).
- `ordering` G2: aligned in this revision (T7, PD7, PD3, the number read at issue, `SellerTurnoverSource` before slice 6).
- `commission-payouts` G2: `commissionTax`, `reverseCommissionTax`, PD8 (with the reversal reference), behaviour on `tax.legal-entity-registration-unknown`.
- Shared-doc PR (review-ali A ruling 9): PLAYBOOK:137 wording, COM-04 formula, IMP-05 reference.

## 17. Review record

| Date | Reviewer | Outcome | Applied in this revision |
|---|---|---|---|
| 2026-10-08 | Mojtaba (database-designer), data design `docs/design/data/tax.md` | Data design written from this model; PD1 confirmed; PD2 to PD8 answered; points M1 to M4 and two PD7 additions | M1 (a) rate `"0"` for `seller-not-registered`; (b) rates compared numerically (2.2, 4.3). M2 (a) windows grouped by zone, (c) refund at its own issue instant (4.10, 11); (b) population via an `ordering` listing, port shape to Ali (T8). M3 optional clear ratio, default no hysteresis, product call to Hadi (4.10). M4 accepted with a refinement: `reverseCommissionTax` from the frozen entry, so `commission-payouts` still computes no GST (4.9, 6.2, PD8). PD7 additions: unit-position ranges with EXCLUDE accepted; charge cumulative ranges accepted; price basis accepted in substance, name disputed (D-1) |
| 2026-10-08 | Ali (cto), Ali G2 review 2026-10-08 | **Approve with changes** (needs Mojtaba data design and Hassan H1 to H4). Rulings T1 B, T2 accepted, T3 D, T4, T5 accepted, T6 0035/0036, T7 settled; ADR-0036 accepted with changes | T7 applied to 6.2, 4.4, 4.6 (`issuedAt` bound, zone from `sellers`, `catalogRevisionId` echo, no region); `ordering` stores the zone `tax` returns (4.6); `LineTaxAnswer` is the frozen `TaxBreakdown` (6.2); the number is never frozen at placement (2.3, 4.4); 15.2 rewritten; ADR-0036 revised (live mode needs the whole agent list, AG-2 and AG-5 named; accepted status; ADR-0007 amended-by line) |
| 2026-10-08 | Hassan (security-tester), Hassan review 2026-10-08 | **Accept with changes** (tax). H1 accept anonymous with a named boundary rule, a no-route/no-tool test and an opaque period id; H2/H7 accept (`at` from the immutable invoice `issuedAt`; reversal originals from C-P's stored entry; validate `before ≤ after` and currency); H3 Medium (golden list, CODEOWNERS, boot and CI refusals); H4 accept (contracts test, never log the number); H5 Medium (turnover is personal information: retention per AG-12 then purge; no trailing total in audit; no Viewer default); H6 accept system-only. ADR-0036 accepted | H1: 4.4, 5.2, 13.4. H2: 4.9. H3: 3.1, 13.4. H4: 6.1, 13.4. H5: 3.2, 5.1, 8, 11, PD6. H6: 5.2 (and `ordering.financialFactsOf`). H7: 4.9, 13.4. 15.3 rewritten as answers. Hassan checks H3 and H5 at code time |
| 2026-10-08 | Ali (cto), follow-ups Ali G2 review 2026-10-08 sections 6 and 7 | D-1 accepted as proposed; T8 approved; M3 Hadi's call, default no hysteresis. Recording: **tax G2 approved with conditions** once Hassan's changes are applied (done in this revision); Hassan checks H3 and H5 at code time; the CODEOWNERS change in its own board-announced PR | D-1: PD7, 15.2. T8: 4.10, 15.2. M3: 4.10. Status line set |
| 2026-10-08 | Mohammad (self), consistency check against the revised `docs/design/data/tax.md` | Three domain-text mismatches, no rule change | 2.1 `ThresholdAlert` fields as TD 3.2; PD5 notes the PD6 exception; PD6 states TD 9: no purge with `sellers`' purge today (F-T1 follow-up), grant plus triggers instead of a definer function |
| — | Reza (ui-ux-designer) | **Pending** for brief s12 (slice 6 threshold banner and status; P1) | — |

**Disagreement D-1:** ruled by Ali (2026-10-08) as proposed (15.2).

**Data-design changes Mojtaba must make:** collected with the `ordering` items in Mojtaba change list 2026-10-08 (2026-10-08). I do not edit `docs/design/data/tax.md` or `docs/design/data/ordering.md`.
