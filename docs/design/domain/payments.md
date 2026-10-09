# Payments — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-08
**Status:** G2 draft 2026-10-08, reconciled 2026-10-08 with Ali's ruling (Ali payments and commission-payouts review 2026-10-08, "Ali PC": approve with changes) and Mojtaba's data design (`docs/design/data/payments.md`; Y1, Y4, Y9 accepted). G2 is recorded once Hassan's H-P1 to H-P6 are answered. Tier A (ADR-0013): Hassan's review is mandatory. Reza (ui-ux-designer) and Jafar follow for the screens of brief s12. Open points: section 16; owner question Q-P1 answered yes (owner, 2026-10-08). Changes: reconciliation log at the end.
**Ground truth:** `docs/modules/payments/brief.md` (G1 approved by the owner 2026-10-08; cited as "brief s5", "Q6", "AC n"); ADR-0035 (Accepted: checkout as an orchestrated process manager in `ordering`; reserve → authorise → commit → capture; payments results only as `payments` events); `docs/design/domain/ordering.md` (cited "OD 3.3"; inputs P-1 to P-9), `docs/design/data/ordering.md` ("OD-data"; open P1), Ali G2 review 2026-10-08 (Ali ordering T1, rulings on O-1 and O-2), Hassan review 2026-10-08 (O-2, O-3, O-7, O-8, ADR-0035 d3, d5, d7), ADR-0038 draft (ADR-0038, Proposed; entries E3 and E4 target `payments`), sellers mini-review inputs 2026-10-08 and sellers mini-review 2026-10-08 (rulings 3, 4, M2), Ali Phase 5 review 2026-10-08, Ali G1 review 2026-10-08 (rulings 3, 4), Phase 5 owner questions 2026-10-08 (Q2, Q3, Q4, Q6, Q8, Q13, Q14), `docs/modules/commission-payouts/brief.md` ("C-P brief"); ADR-0001 to 0009, 0018 (decisions 4, 5, 7), 0019 (R2, decision 10), 0020, 0022 (decision 6), 0025, 0026 (decision 9), 0031 (decision 5); `docs/design/domain/platform-foundations.md` ("PF"), `platform-persistence-and-events.md` ("PE"), `identity.md` ("ID"), `pricing.md` (structure and the `ZZ` fixture), `docs/design/data/platform.md`.
**Stripe facts:** read from the official docs on 2026-10-08 (appendix A, with URLs). Anything not read there is marked **unverified** and listed in 16.

## 1. Scope

A design, not an implementation. Signatures appear only where the signature is the contract.

- **Decided here:** the provider port and the AU adapter (2, 4), the domain model (2), state machines (3), payment, refund, dispute, connected-account and transfer rules (4), webhooks (5), authorisation (6), boundary, facades and events (7), data inputs for Mojtaba (8), audit (9), idempotency and concurrency (10), where each hard rule is enforced (11), jobs (12), AI (13), slices and tests (14), what is deferred (15).
- **The T1 verdict of ADR-0035 decision 4** (manual capture for cards and Apple/Google Pay through Stripe AU; authorisation life well above the step budget): **confirmed, with three conditions** (4.1). ADR-0035 is not revised.
- **ADR-0007's open consequence line** ("the Stripe Connect charge model … open owner decision") is closed here: **separate charges and transfers** (2.3; Ali G1 ruling; CRT-07). The "Amended" note on ADR-0007 goes in the follow-up docs PR (17).
- **In Mojtaba's data design** (`docs/design/data/payments.md`, to be written from this model): tables, columns, constraints, indexes, grants, migrations. Section 8 only names the data and inputs PD1 to PD16.
- **In Reza's and Jafar's documents:** the checkout payment step (provider form inside our frame), payment error and retry, the seller payout-account panel (state, 30-day counter of Q3, cooling-off), admin lists of payments, disputes and connected accounts (brief s12). The server answers with codes (6.5).

### 1.1 Brief slices and where they are covered
| Slice (brief s11) | Covered in |
|---|---|
| 1 Core, port, fake adapter, Money in minor units, inbox/outbox, command keys | 2, 4.2, 7, 10, 14 |
| 2 Stripe adapter (test mode), start payment, webhook (INTL-40); Market payment methods; wallets verified in test mode (Q13) | 2.3, 4.1, 5 |
| 3 Saga connection: authorise, capture, cancel, compensation, late payment (with ordering slice 3) | 3.1, 4.3, 7.2 |
| 4 Connected account: create, onboarding link, state, events | 3.4, 4.6 |
| 5 Transfer and payout execution on C-P's command; VER-10 cooling-off | 3.5, 3.6, 4.7, 4.8 |
| 6 Refunds (RET-06) with the fenced `abandonRefund` (P-7) | 3.2, 4.4 |
| 7 Disputes; `fee-charged.v1` (Q8) | 3.3, 4.9, 4.10 |
| 8 Screens (after Reza's ux.md) | 6, brief s12 |

## 2. Domain model

### 2.1 Aggregates
Every root carries `marketId`, `tenantId`, an `Id` from the injected generator and a `version` (PE 10). Time comes from `Clock` only. Money is the kernel `Money` (`bigint` minor units + ISO 4217). References to other modules are ids only. Provider ids (`pi_…`, `ch_…`, `re_…`, `acct_…`, `tr_…`, `po_…`, `dp_…`, `txn_…`) live **only** inside `payments`, as opaque `ProviderRef` values; no facade answer and no event carries one (they are not secrets, but other modules must never depend on Stripe's identifiers, ADR-0001/INTL-40).

```
Payment            (one per marketId + orderId)
  |-- PaymentAttemptOutcome (0..n)       declines and authentication failures, counted for P-8
  |-- CardDisplay   (0..1)               brand and last4 only (Y1; never PAN/CVC/expiry/network); method used is on Payment
RefundCommand      (one per marketId + key; kind RET06 | COMPENSATION | EXTERNAL)
ProviderCommand    (one per marketId + key; create, capture, cancel, transfer, reversal: the stored key, content hash, lease)
ConnectedAccount   (one active per marketId + sellerId)
  '-- PayoutAccountChange (0..n, append-only)   VER-10 history; cooling-off window
TransferExecution  (one per marketId + instruction key)
  '-- TransferReversal (0..n)
PayoutObservation  (one per provider payout; its id is the `bankPayoutId`, Ali PC)
Dispute            (one per provider dispute)
FeeCharge          (one per provider balance transaction of a fee kind)
ProviderEvent      (webhook inbox; one per marketId + provider + provider event id)
```

| Aggregate | Holds (logical; physical design is Mojtaba's) | Invariants it owns |
|---|---|---|
| `Payment` | `orderId`, `customerAccountId`, requested `amount`, `captureMethod` (always `manual` in Phase 5), `paymentMethodsOffered` (from Market config at creation), status (3.1), authorised, captured, refunded and refund-pending amounts, `authorisationExpiresAt` (from the provider's `capture_before`), `expiresAt` (the reservation's, from `ordering`), `declineCount`, `refundRegime` (`none`, `ret06`, `compensation`), the provider payment ref, `paymentMethodUsed` (`card`, `apple-pay`, `google-pay`; written once at authorisation, Y1), `CardDisplay` | One `Payment` per (Market, order) and at most one successful capture (brief s5). Amount > 0, currency = Market currency, amount ≤ the Market maximum (4.2). Captured ≤ authorised ≤ requested. `refunded + refundPending ≤ captured` at all times (RET-06 cap, brief s5). `refundRegime` is set once by the first refund command and never changes (ADR-0035 d5 mutual exclusion). A final status never moves back (brief s5) |
| `RefundCommand` | `key` (from the caller: `RefundRequest.id` for RET-06, `compensation:<paymentId>`), `paymentId`, `kind`, `amount`, `reasonCode`, requesting actor (admin account id or `SYSTEM`), state (3.2), send lease (`sendingUntil`, attempt token), provider refund ref, `failureCategory` | Content (key, payment, kind, amount, currency, reason) is immutable; the same key with a different amount, currency or payment is refused (ADR-0035 d3). `ABANDONED` is permanent and the key can never be sent afterwards (P-7) |
| `ProviderCommand` | The outbound key of every non-refund provider write (`orderId` for create, `capture:<orderId>`, `cancel:<orderId>`, transfer and reversal keys), a content hash, state, lease | One row per key; same key + other content = refused; stored **before** the provider call (ADR-0035 d3) |
| `ConnectedAccount` | `sellerId`, provider account ref, status (3.4), a requirements summary (counts and categories only, no personal values), `transfersActive`, `payoutsEnabled`, `coolingOffUntil`, the `PayoutAccountChange` history | One non-closed account per (Market, seller). `ready` = status `ENABLED` and not in `RESTRICTED` (sellers ruling 3). Never stores a bank number, BSB, identity document or name (VER-10) |
| `TransferExecution` | `instructionKey`, `reference` (C-P's payout id; no description or free text, Ali PC P-a), `sellerId`, `connectedAccountId`, `amount`, state (3.5), reversed amount, provider transfer ref, `failureCategory`, send lease; or a tombstone (key only, `ABANDONED`; P-d) | Executed only when the account is `ENABLED` and not cooling off at execution time (4.7). `reversed ≤ transferred`. Sent to the provider at most once; never re-sent by `payments` (Ali PC) |
| `PayoutObservation` (`bankPayoutId`) | `sellerId`, provider payout ref, amount, state (`IN_TRANSIT`, `PAID`, `FAILED`, `CANCELED`), arrival date (seller's zone for display), `failureCategory` | Observed only; `payments` never creates a payout itself (4.8) |
| `Dispute` | `paymentId` (`orderId` read from the payment, Y3), amount, reason category, state (3.3), `fundsWithdrawn` (+ withdrawn/reinstated instants), `evidenceDueBy`, outcome | One per provider dispute; amounts from the provider. No fee field: the dispute fee is only a `FeeCharge` (Ali PC P-h) |
| `FeeCharge` | `kind` (`payment-processing`, `connect-active-account`, `connect-payout`, `dispute`, `other`), `amount`, tax part when the provider states it, related `paymentId`/`sellerId`/`disputeId`, provider balance transaction ref | One per provider balance transaction; immutable |
| `ProviderEvent` | Provider event id, type, object type and ref, connected account ref (if any), `livemode`, provider `created`, status (`pending`, `applied`, `ignored`, `dead`), attempts | **No raw body is stored** (5.3) |

### 2.2 Value objects and domain services
| Name | What it is |
|---|---|
| `Money` (kernel) | As ADR-0007 decision 1. Conversion to the provider's minor unit (zero-decimal and special currencies) exists **only in the adapter** (brief s5) |
| `PaymentAmount` | A `Money` that passed `PaymentLimits`: Market currency, > 0, ≤ Market `maxPaymentAmount` |
| `CommandKey` | `^[A-Za-z0-9:_-]{1,128}$` (the shape OD-data already uses for `refund_key`); never contains personal data (Stripe: keys up to 255 characters, no personal identifiers, appendix A) |
| `CommandFingerprint` | A hash of the command's content (target id, amount, currency, kind); compared on every reuse of a key (ADR-0035 d3) |
| `RefundCap` | Pure service: (payment, new amount) → `ok` or `payments.refund.exceeds-captured`; `refunded + refundPending + new ≤ captured` |
| `ConnectedAccountStatusMapper` | Pure service: provider capability and requirement facts → `NOT_STARTED`, `PENDING`, `RESTRICTED`, `ENABLED`, `REJECTED`, `CLOSED` (3.4). Lives in the adapter's anti-corruption layer; the domain only sees our states |
| `PaymentsPolicy` | Per Market, from `config/markets/` (not an ADR-0026 setting: ADR-0026 d9 keeps payment values out of settings): `provider` code, `mode` (`test` only, 4.11), `paymentMethods` (closed list `card`, `apple-pay`, `google-pay`; Q13), `maxPaymentAmount`, `maxDeclinesPerIntent` (P-8), `authorisationHoldMax`, `unconfirmedIntentMaxAge`, `providerCallTimeout`, `refundSendLease`, `transferSendLease` (transfers and reversals; HP-4), `maxTransferAmount` and `dailyTransferAlertThreshold` (`Money`, HP-9), `declineCapAlertRate` (a decimal string in the open interval `(0, 1)`) and `declineCapAlertCount` (integer ≥ 1) (HP-18; Hassan re-check item 3, 12), `payoutAccountSupportContact` (static support contact text for the HP-2 out-of-band notice, 4.6 condition 3; Hassan re-check item 1), `onboardingReturnPath` and `onboardingRefreshPath` (HP-19), `connectedPayoutSchedule` (provider-side, 4.8), secret **references** (names in the secret store, never values; the external-account HMAC key of 4.6 HP-1 included). Checked at boot, no core default; both fixtures (AU and ZZ) carry every value, each with its own currency and number |
| `PaymentProviderAdapter` | The port (2.3) |

### 2.3 The provider port (INTL-40)
`PaymentProviderAdapter` is declared in `payments/domain` (ADR-0001 extension point). One implementation per provider code; the Market's `PaymentsPolicy.provider` selects it through `PaymentProviderRegistry.forMarket(market)`. No `if (market == 'AU')` anywhere: AU gets `stripe` from `config/markets/AU`; `ZZ` gets `fake`. Boot refuses a hosted Market whose provider is unknown or whose `mode` is not allowed (4.11).

| Port method | Meaning (Stripe AU mapping in brackets) |
|---|---|
| `createIntent(market, {amount, captureMethod: 'manual', methods, key, metadata: {paymentId, orderId}})` → provider ref + opaque client data | One intent per order [PaymentIntent with `capture_method=manual`, explicit `payment_method_types: ['card']` (wallets are cards); `transfer_group = paymentId`; no Customer object, no `receipt_email`, no saved methods] |
| `getIntent(market, ref)` → normalised status, amounts, `authorisationExpiresAt`, card display | Re-read of the current object, used by every webhook handler (5.4) |
| `capture(market, ref, key)`, `cancel(market, ref, key)` | Full capture only; cancel = void or close an unconfirmed intent |
| `refund(market, paymentRef, {amount, key, metadataKey})`, `findRefundByKey(market, paymentRef, key)` | [Refund with idempotency key and `metadata.mp_key`; lookup lists the refunds of that PaymentIntent and matches `metadata.mp_key`] |
| `createConnectedAccount(market, {key, country})`, `onboardingLink(market, accountRef, kind: 'onboarding' \| 'update')`, `getConnectedAccount(market, ref)` | [Express-equivalent controller properties, 4.6; Account Links] |
| `transfer(market, {accountRef, amount, key, transferGroup})`, `reverseTransfer(market, transferRef, {amount, key})` | [Transfer from available balance; Transfer Reversal] |
| `getPayout`, `getDispute`, `listFeeTransactions(market, from, to, cursor)`, `getChargeFee(market, paymentRef)` | Observation reads |
| `verifyWebhook(market, endpoint, rawBody, headers)` → verified event header or refusal | [`Stripe-Signature`, tolerance 300 s, constant-time compare, every active secret of that endpoint during rotation] |

Every adapter call has the Market's `providerCallTimeout` (proposal AU 20 s) and returns a closed result: `ok`, `refused(definite)` (a provider 4xx other than 409/429: nothing was created, Stripe stores no idempotent result for a request that never started, appendix A) or `unknown` (timeout, network, 5xx, 409, 429). Only `refused(definite)` lets a caller treat a command as not sent.

**Stripe API version and SDK version are pinned** in the adapter (ADR-0014 dependency rules); an upgrade is its own PR with Hassan's review.

**Fake adapter** (`infrastructure/provider/fake/`): deterministic, in-memory, scriptable outcomes (decline, 3DS failure, capture failure, timeout-but-done, timeout-not-done, refund pending → failed, dispute, account restricted), signs its webhooks with a test secret, supports a zero-decimal currency. It is the only adapter `pnpm verify` uses (offline, deterministic). It is refused at boot for any Market whose config is not a test fixture.

### 2.4 Modelling choices that need a reason
| Choice | Reason | Cost |
|---|---|---|
| **Separate charges and transfers** (closes ADR-0007's open line) | CRT-07: one payment for a multi-seller cart. Stripe's own table names "shopping cart with items from multiple businesses" as the separate-charges case; destination and direct charges carry one connected account per payment (appendix A). Funds stay on the platform until C-P commands a transfer, which is exactly Q3 (sell before the account is ready) and Q6 (platform pays refunds and disputes first) | The platform balance bears fees, refunds and disputes (Stripe: "Your account balance is debited for the cost of the Stripe fees, refunds, and chargebacks"); Stripe recommends this model only when the platform is liable for negative balances, which Q6 already accepts |
| **Express-equivalent connected accounts** (controller: `losses.payments = application`, `fees.payer = application`, `requirement_collection = stripe`, `stripe_dashboard.type = express`), Stripe-hosted onboarding, capability `transfers` | VER-10 forbids holding bank or identity data, so Stripe collects requirements. Stripe **does not support** `stripe_dashboard.type = none` together with `requirement_collection = stripe` and `losses.payments = application` (appendix A), so the dashboard-less option is closed. `fees.payer = application` matches Q8 | The seller has the Express Dashboard and can change bank details there, outside our re-verification. Handled by detection and cooling-off (4.6, VER-10) and listed for Hassan (16, H-P3). The dashboard type cannot be changed later (Stripe), so this is a one-way choice for every AU account. **Hassan HP-1 (High): F-3 is a gate, not a note; the controls are in 4.6** |
| **Transfers from the available balance, without `source_transaction`** | A payout instruction from C-P covers many orders; `source_transaction` ties a transfer to one charge. Transfers happen at least 7 days after delivery (C-P floor), long after AU settlement (2 business days, brief appendix) | An insufficient platform balance is a provider 4xx at creation (Stripe does not retry it): answered **synchronously** as `refused {payments.transfer.insufficient-platform-balance}` with an alert, not as `transfer-failed` (Ali PC); C-P keeps the ledger amount and retries with a new instruction |
| **Thin webhook handling**: verify, store ids only, re-read the object from the provider | Ordering of Stripe events is not guaranteed and duplicates happen (appendix A). Re-reading the object gives the current truth and keeps personal data (billing details, emails) out of our tables | One provider read per applied event (rate within Stripe limits at our volume; 12) |
| **No Stripe Customer object, no saved cards, no receipts from Stripe** | Brief s3 out of scope (no saved cards); nothing personal sent beyond what the provider form collects itself | Receipts come from our order email (Q10) |
| `Payment` and `RefundCommand` are separate roots | A refund has its own key, lease and fence (P-7) and can outlive many retries; the cap still needs the payment, so the refund unit locks the `Payment` row first (10) | Two rows per refund write, in one unit |
| `payments` decides nothing about who is owed | Brief s1; C-P owns "who and how much"; `payments` executes `Money` it is given and only enforces its own caps (Ali r5) | C-P must send complete instructions |

## 3. State machines

### 3.1 Payment (amends brief s5's draft states for manual capture, ADR-0035)
```
REQUIRES_PAYMENT ──customer authorised──▶ AUTHORISED ──capture sent──▶ CAPTURE_REQUESTED ──captured──▶ CAPTURED
   │  ▲ decline (declineCount + 1)            │                              │ provider refused / auth lapsed
   │  └──────────┘                            │ cancel (void)                ▼
   │ cancel | decline cap | backstop expiry   ▼                        CAPTURE_FAILED ──hold still open──▶ (void, then) CANCELLED
   └──────────────────────────────────────▶ CANCELLED
   AUTHORISED ──provider lapsed the authorisation──▶ EXPIRED
   REQUIRES_PAYMENT ──backstop after unconfirmedIntentMaxAge──▶ EXPIRED
```
| From → to | Trigger | Guard | Event |
|---|---|---|---|
| (none) → `REQUIRES_PAYMENT` | `createPayment` (P-1) | Key `orderId` new, or reused with the same fingerprint (then the same answer). Amount valid. Customer = actor | none |
| `REQUIRES_PAYMENT` → same | Provider reports a failed attempt | `declineCount + 1`; at `maxDeclinesPerIntent` (P-8) the next row applies | `payment-failed` (`reasonCategory`: `declined`, `authentication-failed`, `processing-error`; never the provider code or message) |
| `REQUIRES_PAYMENT` → `CANCELLED` | Decline cap reached (P-8): `payments` cancels the intent itself, key `decline-cap:<paymentId>` | — | `payment-cancelled` (`cause: decline-cap`) |
| `REQUIRES_PAYMENT` → `AUTHORISED` | Provider object shows authorised and capturable (`requires_capture`) | Amount authorised = requested, currency equal, capture method manual; authorised **below** the request: still `AUTHORISED`, the event's facts are what `paymentOf` returns, and ordering voids (C9). Authorised **above** the request cannot be stored (PD1 CHECK, Y4): the handler marks the provider event `dead`, alerts and voids the authorisation (stored key first, as every void, 10; the key name and its `provider_commands.kind` value to be added with Mojtaba in slice 3; no `payment-authorized`) | `payment-authorized` |
| `AUTHORISED` → `CAPTURE_REQUESTED` | `capturePayment(system, {paymentId, key: capture:<orderId>})` | Key stored first; full authorised amount only (no partial capture) | none |
| `CAPTURE_REQUESTED` → `CAPTURED` | Provider object shows succeeded | Captured = authorised | `payment-succeeded`; then the processing fee read (4.10) |
| `CAPTURE_REQUESTED` → `CAPTURE_FAILED` | Capture refused definitively, or the object shows cancelled | — | `payment-capture-failed`. If the provider still holds an authorisation, `payments` voids it (key `void-after-capture-failure:<paymentId>`), so no hold is left |
| `REQUIRES_PAYMENT`/`AUTHORISED` → `CANCELLED` | `cancelPayment(system, {paymentId, key: cancel:<orderId>})` | Answer `cancelled`; or `already-authorized` / `processing` (the intent is mid-confirmation, so the cancel is **not** sent; ordering's supersede refuses, OD 3.3); or `already-captured` | `payment-cancelled` (`cause: requested`) |
| `AUTHORISED` → `CANCELLED` | Hold-limit job: authorised and not captured for `authorisationHoldMax` (AU proposal 24 h, always ≤ `authorisationExpiresAt − 6 h`) | Not in `CAPTURE_REQUESTED`; ordering's own step budget (1 h) is far shorter, so this only fires when ordering is stuck (`REVIEW`). **Accepted (Ali A-4)**, with a boot check `authorisationHoldMax` > ordering's `CAPTURING` `stepMaxAge` | `payment-cancelled` (`cause: hold-limit`) + alert (Ali A-4) |
| `REQUIRES_PAYMENT` → `EXPIRED` | Backstop job: `now ≥ expiresAt + unconfirmedIntentMaxAge` (AU proposal 1 h) and the provider object is not authorised | Re-read first; an authorised object takes the `AUTHORISED` row instead | `payment-expired` (`cause: window-passed`) |
| `AUTHORISED`/`CAPTURE_REQUESTED` → `EXPIRED` | Provider cancelled the intent because the authorisation lapsed | — | `payment-expired` (`cause: authorisation-lapsed`) + alert |

Forbidden: a capture of an amount other than the authorised one; a second capture; any transition out of `CAPTURED`, `CANCELLED`, `EXPIRED`, `CAPTURE_FAILED` (refunds change only the refund amounts, not the status); any status set from a client redirect (ADR-0035 d7: only a provider fact re-read by `payments` moves a payment). An event whose provider object is older than what we stored (provider `created`/status order) changes nothing (5.4).

`payment-cancelled` and `payment-expired` reach ordering in `REVIEW` too (hold-limit). OD 3.3 lists them only for `VOIDING`/`AWAITING_PAYMENT`; input **OP-1** to ordering: in `REVIEW` record the fact on the item (no money moved; it unblocks O-7 "close as handled"). Ali A-4: ordering takes OP-1 (ordering mini-review with CP-2 to CP-4).

### 3.2 RefundCommand (RET-06, compensation, the P-7 fence)
```
RESERVED ──send starts (lease)──▶ SENDING ──provider accepted──▶ PENDING ──▶ SUCCEEDED
   │                                 │  └─provider accepted, already final─▶ SUCCEEDED | FAILED
   │                                 │ definite refusal                         PENDING ──▶ FAILED
   │                                 ▼
   │                              REFUSED            (nothing sent)
   │ abandonRefund                   │ lease passed + lookup finds nothing + abandonRefund
   ▼                                 ▼
ABANDONED ◀──────────────────────────┘                (fence: never sent afterwards)
```
| From → to | Trigger and guard |
|---|---|
| (none) → `RESERVED` | `refund` (admin, P-3) or `refundCompensation` (system, P-4). One unit: lock the `Payment` (version), check `refundRegime` (none or the same kind), `RefundCap`, Market, captured status, key fingerprint. A refusal here writes no row and answers a definite code (`payments.refund.exceeds-captured`, `.not-captured`, `.regime-conflict`, `.key-reused`, `.key-abandoned`, `access.denied`) |
| `RESERVED` → `SENDING` | Same request, next unit: write `sendingUntil = now + refundSendLease` (AU proposal 2 min, > `providerCallTimeout` + margin) and an attempt token. Then the provider call, outside any unit |
| `SENDING` → `PENDING`/`SUCCEEDED`/`FAILED` | Provider answer `ok`; written only if the row is still `SENDING` with the same attempt token |
| `SENDING` → `REFUSED` | `refused(definite)` from the provider; the reservation is released from `refundPending` |
| `SENDING` (answer `unknown`) | Stays `SENDING`. The caller gets `payments.unavailable` (ordering keeps `REQUESTED`, OD 3.5). **Nobody re-sends a RET-06 refund** (Ali r5: `payments` refuses a non-admin refund; an admin retry with the same key inside the lease returns the stored state, after it is refused as `payments.refund.in-progress`) |
| `RESERVED`/`SENDING` → `SUCCEEDED`/`PENDING` | `refundByKey` or the resolve job (12) after the lease: `findRefundByKey` finds the provider refund |
| `RESERVED`/`SENDING` → `ABANDONED` | `abandonRefund(system, key)` (P-7), READ COMMITTED, one guarded single-row statement per case (`state` and `attempt_token` in the `WHERE`; Y9, ADR-0025; no `serializable` unit): (a) `RESERVED` (never sent): `ABANDONED` at once; (b) `SENDING` with the lease not passed: answer `in-flight` (ordering asks again later); (c) `SENDING` with the lease passed: **before** the unit, `findRefundByKey`; found → `already-sent` with our refund id (row → `PENDING`/`SUCCEEDED`); not found and the lookup succeeded → `ABANDONED`; the lookup failed → `payments.unavailable`. (d) No row at all: insert an `ABANDONED` tombstone, so a late `refund` with that key is refused (`payments.refund.key-abandoned`) |
| `PENDING` → `SUCCEEDED` / `FAILED` | Webhook re-read of the provider refund |
| `ABANDONED` → (none) | Final. If the provider ever reports a refund carrying this key (a fence failure), `payments` records the provider facts on a new `EXTERNAL` row linked to the key, adjusts the payment's refunded amount (the money really moved), emits `refund-succeeded` with `kind: ret06` and the key, and alerts; ordering then takes `NOT_SENT → REVIEW` (OD 3.5, O-2) |

Answers of `abandonRefund`: `abandoned` | `already-sent {refundId}` | `in-flight` | `payments.unavailable`. Only `abandoned` lets ordering record `NOT_SENT` (O-2).

**Why the fence holds.** A RET-06 key is sent to the provider at most once, from one request, inside a lease longer than the call's own timeout. After the lease, the lookup reads the provider's list of refunds on that payment by our metadata key; Stripe finishes a request it received well within that time. Stripe prunes idempotency keys after 24 h (appendix A), so the provider's idempotency is never the fence: the stored `ABANDONED` state is, and no code path sends a key whose row is not `RESERVED → SENDING` in the same request.

**Fence conditions (Hassan HP-4, H-P2 closed with these; design text before payments slice 4/5 code; built in slice 5 for transfers and reversals, slice 6 for refunds):** the fence must not depend on the request reaching Stripe inside the lease by luck (process stall, slow DNS/TLS, SDK retries).
1. The adapter sets `maxNetworkRetries: 0` for every fenced command (RET-06 and compensation refunds, transfers, reversals). No hidden retries.
2. **Pre-send deadline check:** immediately before writing the request, the adapter checks `Clock.now() + providerCallTimeout + margin < sendingUntil` (margin a named constant); if it fails, nothing is sent and the row is left to the fence. Tested with a fake clock.
3. **Boot checks** per Market: `refundSendLease` and `transferSendLease` ≥ 3 × `providerCallTimeout`; C-P's `transferSendTimeout` ≥ 2 × `transferSendLease` (both `config/markets/` values). Safety does not rest on C-P's value: `abandonTransfer` answers `in-flight` inside the lease; a test runs it with a C-P timeout shorter than the lease.
4. Lookups (`findRefundByKey`, transfer lookup) use **list** endpoints (refunds of the PaymentIntent; transfers by `transfer_group`), never the eventually consistent Search API. A match also checks `metadata.mp_key`, the destination account (transfers) and the amount; a partial match is a fence breach + alert, never `already-sent`.
5. **Transfer quarantine after `abandoned` (HP-4 fix 5, as corrected by Hassan's re-check item 5):** C-P waits at least `TRANSFER_ABANDON_QUARANTINE` after `abandonedAt` and calls `abandonTransfer` again on the `ABANDONED` key; `payments` repeats the **live provider list lookup** by `transfer_group`, matched on `metadata.mp_key`, destination and amount, outside any unit, and answers `still-abandoned` | `already-sent` | `payments.unavailable` (4.7). C-P records `NOT_SENT` only on `still-abandoned` (C-P 3.6). `transferByKey` reads stored state only (data Y8, 6.1) and is never this check.
6. Compensation re-sends are bounded: `send_count ≤ MAX_COMPENSATION_SENDS` (code constant 5, platform-wide, data CHECK); reaching it stops re-sending, alerts and leaves the row `SENDING` for an admin. **Ali (2026-10-08, follow-up (3)):** a `test:db` test reads the literal of `refund_commands_send_bound_check` from `pg_constraint` and asserts it equals `MAX_COMPENSATION_SENDS`, so the two cannot drift (slice 6).
7. **HP-16 (slice 6):** a fence-breach `EXTERNAL` row that the refund cap refuses (a replacement RET-06 still reserved) alerts on its **first** CHECK refusal, not after 10 attempts; the event retries and applies once the replacement settles. Test: breach while a replacement is pending → replacement refused by the provider → breach applies.

**Compensation refunds** (`kind COMPENSATION`, key `compensation:<paymentId>`): system only, amount = the full captured amount (no amount input), refused when `refundRegime = ret06`; RET-06 refused when `refundRegime = compensation` (ADR-0035 d5). Unlike RET-06, ordering's re-drive may call it again with the same key: after the lease and a lookup that finds nothing, `payments` sends again with the same key (Stripe refuses a refund above the charge, so a duplicate cannot pay twice).

**External refunds** (made in the Stripe Dashboard, outside RET-06): recorded as `EXTERNAL`, counted in the cap, `refund-succeeded` with `kind: external` and no key → ordering's orphan refund fact (OD 3.5) + alert. Dashboard access is a control for Kazem and the owner (16).

### 3.3 Dispute (Q6 rule 5)
`OPEN` (needs response / under review) → `WON` | `LOST` | `CLOSED_INQUIRY`. Every transition comes from a provider re-read. On `OPEN`: `dispute-opened` + admin alert. For a chargeback the disputed amount and the fee are debited from the platform balance (separate charges; appendix A): `fundsWithdrawn = true` (+ instant); an inquiry withdraws nothing (`fundsWithdrawn = false`), so C-P posts no debit for it (Ali PC). The dispute fee becomes a `FeeCharge` (4.10) and reaches C-P **only** through `fee-charged.v1` (never through `disputeOf`, Ali PC P-h). On close: `dispute-closed` (`outcome`). `payments` never contacts the seller and never reverses a transfer by itself: recovery is C-P's `instructTransferReversal`, after an admin records seller fault in C-P (Q6). Evidence is submitted by an admin in the Stripe Dashboard (brief flow 7).

**Funds withdrawn or reinstated after opening (Hassan HP-5; before payments slice 7 / C-P slice 6):** an inquiry or warning can turn into a chargeback later, so the withdrawal is not always known at `OPEN`. Whenever a re-read moves `fundsWithdrawn` from false to true (at opening included), `payments` emits `dispute-funds-withdrawn.v1`; when the provider reinstates the funds, `dispute-funds-reinstated.v1` (ids only, 7.2). Owner `payments`, named consumer C-P (posts `dispute-debited` / `dispute-reinstated` keyed by the case; C-P 4.10). Backstop: C-P re-reads `disputeOf` on `dispute-closed.v1` and in its daily reconciliation for open cases; the unique source key makes both paths idempotent. Tests: inquiry → chargeback → won; inquiry → chargeback → lost.

### 3.4 ConnectedAccount
`NOT_STARTED` (account created, onboarding not begun) → `PENDING` (details submitted, Stripe verifying) → `ENABLED` (transfers capability active and payouts enabled) ↔ `RESTRICTED` (requirements past due or capability inactive) → `REJECTED` (Stripe rejected) | `CLOSED` (admin closes the record; a new account may then be created). Every transition comes from a provider re-read (`account.updated` and capability events). `ready = (status == ENABLED)`, independent of cooling-off (cooling-off blocks transfers, not selling; sellers ruling 3). No status event: `connected-account-status-changed.v1` is dropped (no named consumer, ADR-0015; Ali PC); `sellers` and C-P read `payoutReadiness` live.

**Replacement account (Hassan HP-3; payments slice 4):** an account created after a `CLOSED` one is not a first connection: its first external account records kind `replaced` with a cooling-off, so transfers to it wait like any other change. `initial` means the seller's first account ever in that Market (data 3.7 CHECK changed to match). `close-connected-account` requires a recent confirmation (HP-6), raises an admin alert and sends the Seller Owner the HP-2 out-of-band notice (4.6).

### 3.5 TransferExecution
`RESERVED` → `SENDING` → `EXECUTED` | `REFUSED` | `ABANDONED`; `EXECUTED` → `FAILED` (Ali PC: `transfer-failed.v1` only for a transfer the provider created and later failed); reversals: per reversal `RESERVED` → `SENDING` → `REVERSED` | `REFUSED` | `FAILED`. A refusal before sending (`account-not-ready`, `cooling-off`, `key-reused`, `currency-mismatch`) is answered synchronously and writes no execution row (an explicit result, never a silent no-op; brief flow 4). A provider 4xx on the send (insufficient platform balance included) is a synchronous `refused {code}` and the row goes to `REFUSED` (Ali PC). `unknown` keeps `SENDING`. **`payments` never re-sends a transfer itself** (Ali PC; data: `send_count ≤ 1`): the resolve job (12) looks it up at the provider by its key (`transfer_group`/metadata, list endpoint) and records it if found, and `transferByKey` (P-c) then reports the recorded state (P-c is a stored-state read: one statement, no provider call, data Y8); otherwise the row waits for C-P's fenced `abandonTransfer` (P-d, 4.7), after C-P's `transferSendTimeout`, which is longer than the `payments` lease. **Fence breach (Hassan re-check item 5):** `ABANDONED` is final for sending; a transfer that the live lookup finds afterwards (the quarantine pass of 4.7, the resolve job or a late webhook) moves the row `ABANDONED → EXECUTED` once (only a `command` row that was sent; data 3.8 `fence_breached_at`), emits `transfer-executed.v1`, writes audit `payments.transfer.fence-breached` and alerts.

### 3.6 PayoutObservation
`IN_TRANSIT` → `PAID` | `FAILED` | `CANCELED`, from connected-account webhooks (`payout.*`). A failed payout disables the external account at Stripe until new details arrive (brief appendix); `payout-failed` (`bankPayoutId`, `reasonCategory`) lets C-P alert and keep its ledger.

## 4. Payment rules

### 4.1 T1 verdict: manual capture in Stripe AU (ADR-0035 decision 4; Ali ordering T1)
**Confirmed.** Evidence (appendix A, read 2026-10-08):
- Manual capture (`capture_method=manual`) is supported for **cards**, and the wallet table lists **Apple Pay and Google Pay: Manual capture ✓ Supported**; both are processed as card payments (no separate API enum). Both are supported with Connect.
- **Authorisation life for online, customer-initiated card payments: 7 days** for Visa, Mastercard, American Express and Discover (Visa merchant-initiated: 4 days 18 hours; not our flow, since the customer confirms in the provider form). The ordering step budget for `CAPTURING` is `stepMaxAge` 1 h (OD 3.3), so the shortest window in the table is more than 100 times the budget. Ordering's `CAPTURING` `stepMaxAge` must stay below `authorisationHoldMax` (4.1 condition c).
- An expired authorisation releases the funds and the intent becomes `canceled` (Stripe); we map that to `EXPIRED` (3.1).

**Conditions (binding on slice 2 and the Market config):**
1. **eftpos.** Stripe states that eftpos does **not** support manual capture; payments that need a hold are routed to the international scheme (Visa/Mastercard) for co-branded debit cards; **eftpos-routed Apple Pay tokens fail with manual capture**. The Payment Element must be configured with `capture_method: manual` **at render** (the deferred-intent setup), which hides eftpos Apple Pay; the setting must never be added after render (Stripe warns the Element then cannot detect it). A test in slice 2 proves the client configuration. Consequence for the owner (informed, no decision): a customer whose only Apple Pay card is eftpos-routed sees card entry instead; co-branded debit cards are charged on Visa/Mastercard rails, which may cost more than eftpos least-cost routing (fee check with Q8's dashboard figures; unverified).
2. **Wallets verified in Stripe test mode** in slice 2 (Q13): Apple Pay (including domain registration for the web) and Google Pay with manual capture, authorise → capture and authorise → cancel. A wallet that fails is **removed from the Market's `paymentMethods` list**; capture is never switched to automatic for it (ADR-0035 d4: no quiet fallback).
3. **Only card-family methods** are offered: explicit `payment_method_types: ['card']` (wallets ride on it); dynamic payment methods, Link and any method without manual capture are off. Boot refuses a `paymentMethods` value outside the closed list. `authorisationHoldMax` (AU 24 h) < the 7-day window − 6 h, and > ordering's `CAPTURING` `stepMaxAge`: checked at boot against ordering's policy values through config (both are `config/markets/` values).

### 4.2 Starting a payment (P-1)
- `createPayment(ctx, {orderId, customerAccountId, amount, captureMethod: 'manual', expiresAt, idempotencyKey: orderId})`.
- Access: `own-resources`, customer population; `customerAccountId` must equal `ActorContext.accountId`; refused in acting-as. Only `modules/ordering` imports the method (7.1).
- `captureMethod` other than `manual` is refused (`validation.failed`): there is no automatic capture path in Phase 5.
- Key reuse: same `orderId` and the same fingerprint (amount, currency, customer) → the same `paymentId` and fresh client data (the existing intent's client secret, re-read); a different fingerprint → `idempotency.key-reused` (ADR-0035 d3). A payment already in a final status answers `payments.payment.closed` (the decline-cap path: ordering then lets expiry cancel the order).
- Order of work: unit 1 stores `Payment(REQUIRES_PAYMENT)` and `ProviderCommand(orderId)` as `RESERVED`; the provider call; unit 2 stores the provider ref. A crash between them is repaired by the next call with the same key (Stripe idempotency within 24 h, which is far longer than the payment window), or by the backstop.
- Answer: `paymentId` and `clientData` = `{ providerCode, publishableKeyRef resolved to the key, clientSecret }`. The client secret is **never logged, stored in our tables or put in an event**; a log-redaction test covers it (Hassan's code-time list).
- **Return URL (Hassan HP-11; payments slice 2, with the checkout return page and Kazem's edge config):** after a 3DS or wallet redirect Stripe appends `payment_intent_client_secret` to the return URL. Edge and API access logs strip the query string on the payment return route; the return page sends `Referrer-Policy: no-referrer`, loads no third-party resource before it removes the parameter (`history.replaceState`), and never acts on it (ADR-0035 d7). The log-redaction test gains an access-log line for that route. H-P5 closed with this; the publishable key is public by design and gets the `pk_test_` prefix boot check (4.11).
- Errors: provider `unknown` or `refused` → `payments.unavailable` (ordering keeps the order `PENDING_PAYMENT`, C2).

### 4.3 Capture, cancel, and what ordering reads (P-2, P-5, P-9)
- `capturePayment(system, {paymentId, key})`: only from `AUTHORISED` (or `CAPTURE_REQUESTED` with the same key: re-drive). Answers `capture-requested` | `already-captured` | `not-authorised` | `payments.unavailable`. The result itself arrives as `payment-succeeded` or `payment-capture-failed` (ADR-0035 d2: results only as events).
- `cancelPayment(system, {paymentId, key})` → `cancelled` | `already-authorized` (intent mid-confirmation: `processing`/`requires_action`; nothing sent) | `already-captured` | `payments.unavailable`. Re-read of the provider object first; `already-captured` is computed from the provider, not only from our row (O-3, C12).
- `paymentOf(system, paymentId, {refresh?})` → `{paymentId, orderId, marketId, captureMethod, status, amountRequested, amountAuthorised, amountCaptured, amountRefunded, amountRefundPending, currency, refundRegime, authorisationExpiresAt, checkedAt}`. `refresh: true` re-reads the provider and applies it through the same handler as a webhook (used by ordering's `REVIEW` close, O-7). No card data, no provider ids.
- `refundByKey(system, key)` → the `RefundCommand` state and our refund id, after a lookup when the row is `SENDING` past its lease.
- **OD-data P1 answered:** every `payments` payment and refund event carries `orderId` (an id, not personal data). Ordering needs no unique index on `checkouts.payment_id`.

### 4.4 Refunds (RET-06, P-3, P-7)
- `refund(admin ctx, {paymentId, amount, key, reasonCode})`: access `permissions [payments.refund.execute]` (protected), admin population, refused in acting-as, and **`identity.hasRecentConfirmation` required (Hassan HP-6; slice 6)**: a second factor at login is not a recent confirmation. "Protected" has one definition for `payments` and C-P (key held + recent confirmation + not acting-as), applied by the gate for every protected key (ordering O-10 precedent), not re-coded per use case. This is the ActorContext re-check of Ali r5: `payments` never trusts that ordering already checked.
- `payments` executes the `Money` it is given. It only enforces: currency = payment currency, amount > 0, `RefundCap`, the regime exclusion, Market. It never computes an amount from lines or prices (Ali r5).
- The amount is the RET-06 amount ordering computed from the snapshot; partial refunds are allowed; several RET-06 refunds per payment are allowed (each its own key).
- No seller, customer, system or AI path reaches `refund` (AC; R2).
- Every refund command and outcome writes an audit row (9).

### 4.5 Card data (brief s5, hard rule)
- Card numbers, CVC and full expiry pass only between the browser and the provider (Stripe Elements / Payment Element; wallets through the browser payment sheet). No route of ours accepts a card field; the request DTOs have no such field and a contracts test asserts it.
- Stored: **brand and last 4 only** from the provider object, plus the method used (`card`, `apple-pay`, `google-pay`) on the `Payment` (Mojtaba Y1, accepted: no use case reads expiry or network, there are no saved cards, and data we never read is data we cannot leak). Expiry, network and wallet kind on the card record are not stored, although Stripe calls them storable (appendix A). Nothing else from `payment_method_details`.
- Logs: the adapter logs provider object types, refs and status only; request and response bodies are never logged; a log-scan test on the fake adapter's full flows finds no card-shaped string (PAN pattern with Luhn) and no client secret.

### 4.6 Connected accounts and VER-10
- **Create and onboard** (`payments.connect-payout-account`): Seller Owner only (protected seller key, 6.1), `identity.hasRecentConfirmation(ctx, within: payoutAccountConfirmationWindow)` true (ADR-0018 d5, ACC-02, VER-10; input ID-P1), refused in acting-as. Creates the provider account (Express-equivalent controller, capability `transfers`, country from the Market config) with key `connected-account:<sellerId>:<n>` and returns a one-time hosted onboarding link (never stored, never logged). No seller name, email or ABN is sent from our side: Stripe collects them (VER-10; no `sellers` dependency, Ali G1 §6).
- **Resume onboarding / update details** (`payments.open-payout-account-link`): same rule; kind `onboarding` while not `ENABLED`, `update` afterwards.
- **State** comes only from webhooks re-read through `getConnectedAccount` (3.4).
- **VER-10 change of payout account.** Two ways the bank account can change: (a) our `update` link (gated as above); (b) the seller's Express Dashboard at Stripe (not gated by us). Either way the connected-account webhooks (`account.external_account.created/updated/deleted`, `account.updated`) reach us; the handler records a `PayoutAccountChange` (instant, kind, no bank data), sets `coolingOffUntil = detectedAt + coolingOff` (4.7), emits `payout-account-changed.v1` (its consumer depends on Q-P1, 7.2), writes an audit row and alerts the admin queue. The seller is told in the panel and by email: **answered yes (owner, 2026-10-08, Q-P1): a fifth, security email to the Seller Owner, with no bank data, a link to the panel only, sent to the identity-held address, and it cannot be turned off.** The first account connection does not start a cooling-off; every later change does (HP-3: "first" = the seller's first account ever in that Market; an account after a closed one is `replaced`, 3.4).
- **Cooling-off value:** default 24 h (VER-10), editable by an admin per Market. Brief s5 and VER-10 make it admin-editable; ADR-0026 decision 9 says "payment and commission values" are never a setting. **Ruled (Ali A-5):** it is a **security delay**, not a payment value, so it is an ADR-0026 setting `payments.payout-account-change-cooling-off` owned by `payments` under ADR-0026 decision 7 (protected key with a hard minimum; no new ADR): bounds in code lower 24 h, upper 14 days; a settings-store read error → the upper bound (stricter wins); protected key `payments.settings.edit`, `hasRecentConfirmation`, refused in acting-as; Hassan reviews (ADR-0026 d9: every new editable setting). A shorter value applies only to later changes (`coolingOffUntil` is never shortened, Y12). **Accepted by Hassan (2026-10-08):** bounds 24 h to 14 d, store error → upper bound, never shortens (trigger measured), protected key with recent confirmation, refused in acting-as, audited with old and new value (`payments.settings.changed`, 9). Slice 4.
- **Takeover of the payout destination (Hassan HP-1, High).** The cooling-off gates only our `instructTransfer`; money already on the connected account is paid out by Stripe's daily schedule (4.8), and a change made in the Express Dashboard bypasses our 2FA. Conditions:
  1. **Gate on F-3 (test mode, before payments slice 4 merges; Hassan re-checks the design before slice 4/5 code and C-P slice 5 code).** One of two outcomes must be designed, built and tested before slice 4 merges; slice 5 code starts only after the outcome is recorded here:
     - **Option 1 (F-3 closes):** Stripe lets the platform stop Express users from editing external accounts → it is turned off at account creation. The bank account then changes only through our `update` link (Seller Owner, recent confirmation, no acting-as; above).
     - **Option 2 (F-3 cannot be closed):** when a `PayoutAccountChange` (any kind but `initial`) is detected, `payments` sets that account's provider payout schedule to `manual` (payouts paused) until `coolingOffUntil`, then the job `payments.restore-payout-schedules` (12) restores the Market `connectedPayoutSchedule`. Both writes are stored provider commands (keys `payout-pause:<changeId>`, `payout-resume:<changeId>`; 10) with audit rows (9). Verified in test mode that the platform may set this on Express-controller accounts. Funds paused stay far below the 90-day manual-payout limit (cooling-off ≤ 14 d).
     - **Pause and resume serialisation (Hassan re-check 2(c); slice 4):** every pause or resume **send** for one connected account runs under a session advisory lock on the account ref (data 3.7), taken before the guarded statement and released after the recording unit. The unit that records a change and extends `payouts_paused_until` takes no lock (the guarded clear catches it), but its pause send waits for the lock, so it is sent after any resume already in flight. The resume is a **guarded clear** first (`payouts_paused_until = NULL WHERE payouts_paused_until = <value read> AND status <> 'closed'`), and the resume command is sent only when that statement changed one row; zero rows means a new change extended the pause and nothing is sent. **Re-read check:** an `account.updated` re-read (webhook or the daily reconciliation) that shows a payout schedule other than `manual` while `payouts_paused_until` is set re-pauses the account (stored key `payout-repause:…`, 10), writes audit `payments.payout-account.payouts-repaused` and alerts; this also catches a schedule change made in the Dashboard. The F-3 test-mode check must also confirm that an Express user cannot change the payout schedule; if they can, Hassan re-reviews option 2 before slice 4 merges.
  2. **Pre-transfer live check (closes HY3; payments slice 5):** `payments` stores a keyed HMAC (`hmac-sha256:k<version>:<hex>`, the key version stored so a key rotation is not a detected change (Mojtaba G2, data 3.7), key by reference from the secret store, purpose `payments.external-account`) of the default external account's provider id, updated by the account webhook handler; never the raw id (not bank data under VER-10). In `instructTransfer`, **outside any unit and before reserving**, `getConnectedAccount` is re-read live and the HMAC compared: a mismatch (or a live state that is not transfer-ready) is a detected change: the handler path records a `PayoutAccountChange`, starts the cooling-off and the answer is `payments.transfer.cooling-off`; a failed read answers `payments.unavailable` and reserves nothing. Never transfer on a stale state. One provider read per transfer (weekly per seller). **No fallback (Hassan re-check item 4, Ali's reading):** a failed live read never falls back to the stored state; it reserves nothing and starts no cooling-off and no pause (the control is "no transfer"). Each failure increments `payments_live_check_failures_total{market}`; Kazem's alert rule fires when one Market has ≥ 5 failed live reads in a trailing hour or one account fails on 3 consecutive instructions (thresholds in the alert config, proposals). **HMAC rules (Hassan re-check item 6; slice 4 writes, slice 5 reads; data 3.7):** (i) a NULL stored HMAC never matches: the transfer is refused `payments.transfer.account-not-ready` until a webhook or a live read stamps it; (ii) the comparison is constant-time on the whole value; (iii) a key-rotation re-stamp first computes the HMAC of the live provider id with the **stored** version's key and writes the new-version value only if that equals the stored value; otherwise it records a `PayoutAccountChange` (`detected_by = live-check`) with a cooling-off, never a re-stamp; (iv) old key versions stay readable until no row references them; a stored version whose key is missing answers `payments.unavailable` plus an alert, never a re-stamp; (v) a write of a different HMAC under the same version happens only in the same unit as a `PayoutAccountChange` row (repository rule plus a test).
  3. **Out-of-band notice (HP-2, High; live-mode condition, independent of Q-P1):** live mode (4.11) is not switched on unless every payout-account change (kinds `added`, `updated`, `removed`, `replaced`, and a close, HP-3) sends the Seller Owner an out-of-band message to the **identity-held** email (never an address from Stripe), with no bank data and only a link to the panel, not suppressible by any preference. The message names the support contact as **static text from Market config** (`PaymentsPolicy.payoutAccountSupportContact`; no core default, both fixtures), never a contact or link taken from the panel, Stripe or the request, because the attacker may hold the panel (Hassan re-check item 1). Q-P1 is answered yes (owner, 2026-10-08): the fifth email is this message, so HP-2 is satisfied by design (15). Not a slice-code blocker.
  4. **"This wasn't me" (HP-2; payments slice 4 for the use case, C-P slice 5 for the hold; screen by Reza/Jafar):** new use case `payments.report-payout-account-change` (owner `payments`): Seller Owner, own seller, the change id from the panel; it records the report (audit, admin alert) and emits `payments.payout-account-change-reported.v1` (7.2); named consumer C-P, which places a system `ADMIN_REVIEW` seller hold and an admin task (C-P 3.5). **Effect on the provider payout pause (Ali 2026-10-08, (2b)):** the report never shortens anything (cooling-off and pause only extend). Under HP-1 option 2, a report keeps the provider payout pause in place until an admin resolves the report, capped at 14 days from the change's `detectedAt` (the cooling-off upper bound, 4.6), so paused funds stay far below Stripe's 90-day limit. Mechanism: the report unit sets `payouts_paused_until = detectedAt + 14 d` on the account (extend only, never earlier than the stored value); if the pause was already lifted and the cap has not passed, it pauses again with a stored command keyed `payout-pause:<reportId>`. The resolution is the admin use case `payments.resolve-payout-account-change-report` (`permissions [payments.connected-account.close]`, protected: recent confirmation, acting-as refused; reason code `owner-confirmed` or `account-closed`, no free text; audit); `owner-confirmed` is accepted only after the Seller Owner has **withdrawn** the report in the panel (below; recorded as `owner_withdrawn_at`, data CHECK), so one admin taking a phone call cannot lift the pause (Hassan re-check 2(a)); otherwise `payments.payout-account.report-not-withdrawn`. **A `support`-channel report is never resolved `owner-confirmed` (Hassan HP-1 close-out, item 2(a); slice 4):** the support entry exists because the attacker may hold the panel, step-up included, so a panel withdrawal of a `support` report is refused with `payments.payout-account.report-not-withdrawable` (nothing written), and such a report ends only by `account-closed` or at the 14-day cap; `owner-confirmed` on it is refused by the use case (`payments.payout-account.report-not-withdrawn`, as no withdrawal can exist) and by the data CHECK `payout_account_change_reports_support_resolution_check` (data 3.7). On `owner-confirmed` the pause ends at `max(now, coolingOffUntil)` through the restore job (`payouts_paused_until` set to that value). **`account-closed` keeps the pause (Hassan re-check 2(b)):** the schedule stays `manual`, the restore job never restores a `closed` account, and the money still on the connected account is recovered through C-P's `command-transfer-reversal` (reason `payout-account-compromised`, C-P 4.11) before the record closes: under an open report `close-connected-account` reads the account's provider balance live and refuses with `payments.connected-account.balance-remaining` while it is not zero (a failed read → `payments.unavailable`); `account-closed` is accepted only on a `CLOSED` account (else `payments.connected-account.not-closed`). The daily reconciliation alerts on any `CLOSED` account whose provider balance is not zero (audit `payments.payout-account.closed-balance-remaining`). **Withdrawal** (`payments.withdraw-payout-account-change-report`, new, owner `payments`; Hassan re-check 2(a)): Seller Owner, own seller, `permissions [payments.payout-account.view]` (protected: recent confirmation; acting-as refused); an unresolved report of that seller in the context's Market, else byte-identical not-found; writes `owner_withdrawn_at` and `owner_withdrawn_by_account_id` once; lifts nothing by itself (the pause and the C-P hold stay until the admin resolution and the admin hold release); audit `payments.payout-account.change-report-withdrawn` and an admin alert; **no event** (its only consumer is the admin queue, which reads the row; ADR-0015). At the cap without a resolution, `payments.restore-payout-schedules` (12) restores the schedule and alerts the admin queue; the C-P `ADMIN_REVIEW` hold keeps stopping our transfers. The C-P hold alone stops only our transfers, not Stripe paying out money already on the connected account; hence this pause. Under option 1 there is no provider pause and the C-P hold is the effect. After the cap, a report places no provider pause (the C-P hold applies). Hassan re-checks this with HP-1. **Access (Ali 2026-10-08, (2a)):** `permissions [payments.payout-account.view]`, a protected key, so under the one-definition rule (HP-6) the gate's recent-confirmation step applies, and acting-as is refused. There is no per-use-case exemption from step-up. **Support entry (Hassan re-check item 1, replacing the earlier C-P-hold fallback, which did not stop Stripe paying out money already on the account):** if the real owner cannot complete step-up (the attacker may hold the panel), support uses the admin use case `payments.report-payout-account-change-for-seller` (new, owner `payments`; `permissions [payments.connected-account.close]`, protected: recent confirmation, acting-as refused; the change must be in the context's Market, else byte-identical not-found). It writes the same report row with `reported_by_account_id` = the admin and `channel = support` (the seller entry writes `seller-panel`; data 3.7), applies the same pause and 14-day cap and emits the same `payout-account-change-reported.v1` (consumer C-P), so C-P places the hold: one support action, not two. A report only extends pauses, so a mistaken support report costs a delay, never money. **Support runbook (Hassan HP-1 close-out, informational):** at the 14-day cap the restore job restores the schedule (Ali (2b)), so Stripe would pay money still on the connected account out to the hijacked bank account unless the account is closed first; the support runbook therefore tells support, within the cap, to start C-P's recall (`command-transfer-reversal`, reason `payout-account-compromised`, C-P 4.11) and close the connected account (`close-connected-account`, then resolve `account-closed`), never to let a support report run to the cap.
  5. **Pen-test scope (14):** Express Dashboard change, webhook delay, a payout in flight, the full chain.
- **Onboarding links (Hassan HP-19; slice 4):** Account Link `return_url` and `refresh_url` are built by code from Market config (`onboardingReturnPath`, `onboardingRefreshPath`), never from request input (no open redirect); the link is returned only in the response body with `Cache-Control: no-store`.
- **Readiness for `sellers` and C-P** (sellers rulings 3 and M2; Ali PC P-e): `payoutReadiness(ctx, sellerIds ≤ 100)` → per id `{ready: boolean}`, an `anonymous`/`system` pair, from the stored `ConnectedAccount` state only (no provider call per request), one read-only statement opening no transaction (ADR-0025), hard deadline (`payoutReadinessDeadline`, named constant, proposal 300 ms) and bounded concurrency; unknown or other-Market id → `ready: false`; a larger batch is refused whole. Contract file importable only by `modules/sellers`, `modules/commission-payouts` and the composition root (named boundary rule, sellers ruling 4; Ali PC P-e).
- **Stripe holding limit (Ali G1 ruling 3; sellers ruling 4):** Stripe's 90-day limit ("all other countries") applies to funds held on a **connected account** with manual payouts. Under separate charges, a not-ready seller's money stays on the **platform** balance, and no Stripe page read states a limit for that. So the Stripe-derived upper bound of `sellers.payout-account-grace-days` is not a Stripe rule for our model; the binding limit is legal (Q3 lawyer list) and C-P's policy for a seller who never onboards. Recommendation for `sellers`' code constant: upper bound 90 days (the conservative Stripe figure), until the lawyer answers; listed in 16 (S-P1). Ali PC: the 90-day upper bound for the 30-day cap is **our policy pending the lawyer**, ruled through the sellers mini-review (S-P1); the default stays 30 days in `config/markets/` (Hadi decision 4, lower bound 0, store read error fails closed).

### 4.7 Transfers (C-P commands; IMP-01, PAY-05/06 execution only)
- **P-a** `instructTransfer(system, {instructionKey, sellerId, amount, reference: payoutId})` → `accepted {transferExecutionId}` | `refused {code}` | `payments.unavailable` (Ali PC). `reference` is C-P's payout id (an id, put in transfer metadata and `transfer_group`). **No description field**: nothing free-form reaches the provider. `accepted` means the provider created the transfer; the outcome after creation arrives as `transfer-executed.v1` / `transfer-failed.v1`.
- Refusal codes (definite): before sending, nothing reserved: `payments.transfer.account-not-ready` (no account, or not `ENABLED`, `RESTRICTED` included), `payments.transfer.cooling-off` (VER-10; `coolingOffUntil > now`), `payments.transfer.currency-mismatch`, `payments.transfer.account-under-review` (Ali CP-R1 condition 5, below), `idempotency.key-reused`, `validation.failed` (amount ≤ 0); after sending, a provider 4xx (other than 409/429) on creation is a synchronous refusal too: `payments.transfer.insufficient-platform-balance` or `payments.transfer.provider-refused` (Ali PC; never `transfer-failed.v1`). C-P maps these codes as given (no C-P synonyms). The account state is re-read inside the reserving unit after the account row lock (stored state; a webhook-fresh value) and the cooling-off is checked against `Clock`. **Before that unit**, the live provider check of 4.6 HP-1 condition 2 runs (slice 5).
- **No transfer while a report is open (Ali CP-R1 condition 5; payments slice 5):** `instructTransfer` refuses, before reserving anything, any transfer to a connected account that has an unresolved payout-account-change report (any channel; `resolved_at IS NULL`, data 3.7), with the definite code `payments.transfer.account-under-review`; C-P maps it as given (`NOT_SENT`). The check reads the stored report rows and is repeated in the reserving unit after the account row lock, as the account state is. Reason: if an admin released the C-P hold before the hijacked account was closed, recalled money would otherwise go back to the attacker; with this rule either resolution (`account-closed` on a `CLOSED` account, or `owner-confirmed` after the owner withdrew the report) makes a transfer safe. A report left unresolved at the 14-day cap keeps refusing transfers to that account (a replacement account is a different account). Hassan re-checks this with HP-1 before slice 5 code.
- **Transfer ceiling (Hassan HP-9; payments slice 5):** an amount above `PaymentsPolicy.maxTransferAmount` (per Market, no core default, both fixtures) is refused before reserving with `payments.transfer.amount-out-of-range` + alert; if the read of `maxTransferAmount` fails, the answer is `payments.unavailable` and no transfer is made (fail closed; Ali 2026-10-08 (3)); the value is `{amount, currency}` and loading fails when its currency differs from the Market's; the daily reconciliation job alerts when the day's executed transfer total passes `dailyTransferAlertThreshold`. A sanity cap like `maxPaymentAmount`; eligibility stays C-P's.
- **No self-initiated re-send** (Ali PC): an `unknown` answer leaves the row `SENDING`; `payments` only looks it up by key (3.5). Resolution is C-P's: **P-c** `transferByKey(system, instructionKeys ≤ 100)` → per key state, `transferExecutionId`, amount and reversed amount (replaces `transferResultOf`; stored state only, no provider call, data Y8); then, after C-P's `transferSendTimeout` (> the `payments` lease), **P-d** `abandonTransfer(system, instructionKey)`, a copy of the `abandonRefund` fence (3.2): lease; past the lease a provider lookup by `transfer_group`/metadata outside any unit; `ABANDONED` final; an unknown key gets a tombstone so a late `instructTransfer` with it is refused → `abandoned` | `already-sent {transferExecutionId}` | `in-flight` | `payments.unavailable`. READ COMMITTED, one guarded single-row statement per case (Y9). Hassan reviews it with H-P2. **Quarantine pass (Hassan HP-4 fix 5 as corrected by his re-check item 5; slice 5):** the first answer `abandoned` carries `abandonedAt`. Called again on a key already `ABANDONED`, `abandonTransfer` repeats the **live provider list lookup** by `transfer_group`, matched on `metadata.mp_key`, destination and amount, outside any unit, and answers `still-abandoned` (nothing found; no write) | `already-sent {transferExecutionId}` (found: the fence breach of 3.5, row → `EXECUTED`, alert) | `payments.unavailable` (the lookup failed: C-P waits and asks again). A partial match is a breach alert and answers `payments.unavailable`, never `still-abandoned`. C-P records `NOT_SENT` only on `still-abandoned` (C-P 3.6).
- **What `payments` does not check:** whether the seller is owed, suspended (Q14), past their hold days, in MANUAL mode or approved by an admin, whether the Seller Owner has a second factor (C-P eligibility conditions 1 to 9). Those are C-P's (Q4: `payments` executes both AUTO and MANUAL, only after the command).
- **P-b** `instructTransferReversal(system, {key, sellerId, transferExecutionId, amount, reasonCode})` → `reversed` | `refused` (`exceeds-transferred`, `key-reused`, `seller-mismatch`: `sellerId` differs from the execution row's, Hassan HP-8, definite, nothing reserved; test with two sellers; payments slice 5) | `failed (insufficient-account-balance)` (Stripe reverses only when the connected account's available balance covers it) | `payments.unavailable`. An unknown outcome is resolved **by key lookup**, never by a re-send (Ali PC). A failure after creation emits `transfer-reversal-failed.v1`, which C-P consumes; C-P then nets the amount from later payouts (Q6 rule 4).
- **P-f** `feeChargesOf(system, feeChargeIds ≤ 100)` → kind (payments' names: `payment-processing`, `connect-active-account`, `connect-payout`, `dispute`, `other`; C-P alerts on `other`), amount, tax part when stated, `orderId` when the fee relates to a payment, `sellerId` when attributable. **P-h** `disputeOf(system, disputeIds ≤ 100)` → `orderId`, amount, `fundsWithdrawn`, outcome; **no fee** (the dispute fee only via P-f). **P-i** `dailyTotalsOf(system, {from, to})` → `payments`' own facts per currency (captured, refunded, transferred, reversed, fees, dispute withdrawals and reinstatements) in `[from, to)`; the instants are computed by C-P (Market-zone day), and C-P maps the facts to its chart of accounts. All read-only, no transaction (ADR-0025).
- Every method of `payments.payout-execution.ts`: access `system`, importable only by `modules/commission-payouts` (named boundary rule; C-P is its only importer, Ali PC), never elevatable (ADR-0038 d2), audited where it writes.

### 4.8 Payouts to the seller's bank
- Transfers are the controlled step. Each connected account gets the provider-side payout schedule from the Market config (`connectedPayoutSchedule`: AU `daily`, minimum delay) when it becomes `ENABLED`, so money that reached the account is paid out by Stripe, never left there towards the 90-day manual-payout limit (appendix A).
- `payments` observes payouts (`PayoutObservation`, id `bankPayoutId`) and emits `payout-paid` / `payout-failed`. The payout fee becomes a `FeeCharge` (4.10). `payoutOf` is dropped: C-P stores bank-payout observations from the events and needs no amount (A-3; Ali PC facade list).
- C-P's schedule in the seller's zone (Q4, PAY-10/11) decides when transfers happen; `payments` holds no schedule rule.

### 4.9 Disputes (Q6 rule 5)
As 3.3. Dispute amounts and `fundsWithdrawn` are read through `disputeOf(system, disputeIds ≤ 100)` by C-P (P-h, 7.1); the fee only through `fee-charged.v1` + `feeChargesOf` (P-f), so it is counted once. The platform bears the dispute fee (Q6); `payments` only reports it.

### 4.10 Stripe fees (Q8): `fee-charged.v1`
- Kinds and sources: `payment-processing` from the captured charge's balance transaction (read once after `CAPTURED`); `dispute` from the dispute's balance transactions; `connect-active-account` and `connect-payout` from a daily job that lists the platform's fee balance transactions for the previous day (12). Refunds do not return the processing fee (Stripe pricing, brief appendix), so no negative fee is emitted for a refund.
- One `FeeCharge` per provider balance transaction (idempotent); the event carries ids and the kind; C-P reads the amount through `feeChargesOf(system, ids ≤ 100)` (P-f, 7.1; no amounts in events, Ali A-3). The dispute fee reaches C-P only on this path (Ali PC).
- **Unverified:** how Stripe bills the Connect monthly active-account fee and the payout fee to an AU platform (as balance transactions, an invoice, or a monthly statement), and whether fee balance transactions state the GST part. If a fee is not visible as a balance transaction, the daily job cannot report it and C-P records it from the Stripe invoice by an admin entry (C-P's decision). Slice 7 starts with a test-mode check (16, F-1).

### 4.11 Test mode only (brief s5 hard rule; Q2)
- `PaymentsPolicy.mode` accepts only `test` in Phase 5. Live mode is refused at boot by a code constant (`LIVE_MODE_ALLOWED = false` in `payments/infrastructure/provider/`), whose change is its own PR with Hassan's sign-off, after the independent pen test passes and Bagher's release gate.
- Every webhook's `livemode` must equal the Market's mode; a mismatch is refused with 400 and alerts (5.2). A key whose prefix is not the test prefix is refused at boot (Stripe secret keys start `sk_test_` in test mode; adapter check). **HP-10/HP-11:** the boot check accepts `rk_test_` or `sk_test_` for the secret key and `pk_test_` for the publishable key.
- **HY1 accepted (Hassan):** the database CHECK `livemode = false` (data Y8) stays as a second lock beside `LIVE_MODE_ALLOWED` and the prefix checks; removing it is its own migration with Hassan's sign-off, in the live-mode PR.
- **Live-mode conditions (Hassan; with the pen test and Bagher's gate):** HP-2 (the out-of-band notice of 4.6, the fifth email, Q-P1 = yes) and HP-10: named Stripe Dashboard users only, enforced 2FA or SSO, least-privilege Stripe roles (no Administrator for day-to-day use; refunds only for the finance admin); a quarterly review of Stripe's team and security history, recorded; the adapter uses a **restricted key** (`rk_…`) scoped to the endpoints it calls, not a full `sk_` key; live keys are not provisioned in any secret store until the live-mode PR (Kazem with the owner).

### 4.12 Market and Vertical
- Provider, account refs, methods, limits and timings come from `config/markets/<code>` (`PaymentsPolicy`); secrets from the secret store by reference. AU: `stripe`, methods `card`, `apple-pay`, `google-pay` (subject to 4.1 condition 2). ZZ: `fake`, JPY (exponent 0), methods `card` only, different limits.
- Every root and row carries `market_id` and `tenant_id`; every webhook is mapped to one Market by its endpoint (5.1), never by default.
- No vertical-specific rule exists in `payments`.

## 5. Webhooks

### 5.1 Endpoint and Market resolution
- One endpoint per (Market, destination): `POST /webhooks/payments/{market}/{destination}`, destination `platform` (charges, refunds, disputes, transfers, platform balance) or `connected` (accounts, external accounts, payouts) (Stripe Connect's two webhook destinations, brief appendix). Each has its own signing secret(s) per Market.
- The provider sends no `x-market-id`, so PF 5.1's HTTP guard cannot resolve the Market. **Ruled (Ali A-1): option A**, in its own PF-amendment PR (shared file, board-announced), Hassan reviews; option B is not taken.
  - **Option A (chosen):** a fourth entry adapter in `platform/webhooks/`: the route is exempt from `MarketContextGuard` (PF rule 6 of 8.2 gains `platform/webhooks/` beside the guard file and `platform/health/`), resolves the Market from the path segment through `MarketContextFactory.forMarket` (unknown or not hosted → 404, nothing logged but a counter), mints the Market's anonymous actor and passes the raw body to the module's registered receiver. A PF amendment in a small shared-file PR; Hassan reviews.
  - **Option B:** the edge maps each webhook URL to an `x-market-id` header. No platform change, but correctness depends on proxy configuration that the code cannot test.
  - **Conditions on option A (Hassan HP-13; the PF-amendment PR):** the `MarketContextGuard` exemption covers the exact path prefix `/webhooks/payments/` only; no session, cookie or CSRF handling runs on it; the anonymous context it mints reaches only the registered receiver use case `payments.receive-provider-event` (a boundary or registry check plus a fixture); an unknown or unhosted Market answers 404 with only a counter whose label cardinality is limited.
- Raw body: the route receives the unparsed bytes (body limit 512 KB, content type `application/json`); no JSON parsing before verification.

### 5.2 Receive (`payments.receive-provider-event`, access rule `anonymous`, in the C4 list)
1. `verifyWebhook` with every active secret of that (Market, destination): signature, timestamp tolerance 300 s, constant-time compare (Stripe library). Failure → 400 `payments.webhook.invalid`, nothing stored, a rate-limited warning log without the body.
2. Checks on the verified header: `livemode` = the Market's mode; for `connected`, the event's account is a stored `ConnectedAccount` of that Market, or an account creation we initiated (pending ref); for `platform`, no foreign account field. A failure → 400 and an alert (a signed event that does not fit is a configuration or key problem).
3. Insert `ProviderEvent` (ids, type, object ref, account ref, `created`, `livemode`) with `ON CONFLICT DO NOTHING` on (Market, provider, event id); duplicate → 200.
4. Answer 200 quickly. No domain change happens in the request.
- Unknown event types are stored as `ignored` (counted, not processed). The provider's IP allow-list and request rate limits sit at the edge (Kazem; Stripe recommends an IP allow-list, brief appendix).
- The anonymous rule writes only to the webhook inbox; the signature is the authentication. Signing secrets rotate with Stripe's 24-hour overlap (both secrets active during the overlap).
- **Reconciliation-enqueued events (Hassan HP-12.2; slice 2):** an event inserted by the reconciliation job (`received_via = reconciliation`) passes the same step-2 checks (`livemode`, for `connected` a stored account of that Market) before insert.

### 5.3 What is stored
Only the fields in 5.2 step 3. The raw body and the object snapshot are **not** stored: they can contain billing details, email and IP data. Retention: `ProviderEvent` rows are kept at least 30 days (well beyond Stripe's 3-day retry window), then pruned by the platform prune job (PD5).

### 5.4 Process (`payments.apply-provider-events`, `system`, worker job)
- Claims `pending` events per Market (`FOR UPDATE SKIP LOCKED`), groups them by object ref, and serialises per object (one worker per object at a time, advisory lock on the object ref).
- For each object: `get…` re-read from the provider (outside any unit), then one unit that maps the current object onto the aggregate and appends our events to the outbox. The aggregate only moves forward (3.x tables); a re-read that shows an older or equal state changes nothing. All events of that object claimed in the batch are marked `applied` in the same unit.
- **Hassan HP-12.1 and HP-12.3 (slice 2):** the re-read of a `connected` event uses the **stored** account ref checked in 5.2 step 2 (the `Stripe-Account` header from our row), never a ref from the payload; every write after the re-read is matched by our stored provider ref (the unique keys), never by `metadata.paymentId`. H-P1 closed with HP-12 and HP-13.
- Provider read failure → retry with the PE back-off; after 10 attempts `dead` + alert. A webhook for an object we do not know (a payment created outside our system, a stray account) → `ignored` + alert (`payments.provider.unknown-object`).
- Missed webhooks: the reconciliation job (12) re-reads every non-final object daily and lists provider events of the last 3 days (Stripe keeps events 30 days; unverified retention for Connect events) to catch gaps.

## 6. Authorisation (ADR-0018, ID 5.2)

### 6.1 Permission catalogue (`modules/payments/contracts/permissions.ts`; `registerPermissions('payments', CATALOGUE)` in `payments.module.ts`)
| Key | Scope | Protected | Allows |
|---|---|---|---|
| `payments.payout-account.view` | seller | **yes** | See the payout account state, requirement summary, cooling-off and history. Protected seller keys are not grantable in Phase 2's narrowing (ID R11), so only the Seller Owner holds it: "Staff has no access to the payout account" (brief s2) |
| `payments.payout-account.manage` | seller | **yes** | Connect the account, open onboarding/update links |
| `payments.payment.view` | platform | no | List and view payments, refunds and their states (no card data beyond brand/last 4) |
| `payments.refund.execute` | platform | **yes** | Execute a RET-06 refund (the re-check behind `ordering.refund.execute`). Ruled (Ali A-2): `payments`' own key, seeded with `ordering.refund.execute` (finance admin only, Hadi decision 1) |
| `payments.dispute.view` | platform | no | List and view disputes |
| `payments.connected-account.view` | platform | no | List connected accounts, states, cooling-off and change history |
| `payments.connected-account.close` | platform | **yes** | Close a connected-account record (seller left, account rejected) |
| `payments.settings.edit` | platform | **yes** | Edit the VER-10 cooling-off setting (Ali A-5: an ADR-0026 setting) |

### 6.2 Use cases
| Use case | Access rule | Ownership / notes |
|---|---|---|
| `payments.create-payment` (P-1) | `own-resources` (customer) | `customerAccountId` = actor; Market of the context; acting-as refused |
| `payments.view-own-payment` | `own-resources` (customer) | The payment's `customerAccountId` = actor, else `payments.payment-not-found` (byte-identical for absent, other customer, other Market). Status, brand/last 4, refunds with amounts and states |
| `payments.capture-payment`, `payments.cancel-payment` (P-2) | `system` | `cancel-payment` is elevatable (ADR-0038 entry E3); `capture-payment` never |
| `payments.payment-of` (P-5, P-9) | `system` | Elevatable (entry E4); `refresh` allowed under elevation **only when the entry is the admin `REVIEW` close (O-7)**; any other entry asking `refresh` is refused, with a test (Hassan HP-14; before payments slice 3) |
| `payments.refund` (P-3) | `permissions [payments.refund.execute]` | Admin; payment in the context's Market; acting-as refused; recent confirmation (HP-6) (one gate check for protected keys, as ordering O-10) |
| `payments.refund-compensation` (P-4) | `system` | Never elevatable; importable only by ordering |
| `payments.refund-by-key`, `payments.abandon-refund` (P-5, P-7) | `system` | Never elevatable |
| `payments.receive-provider-event` | `anonymous` | 5.2 |
| `payments.apply-provider-events` and the jobs of 12 | `system` | Per hosted Market |
| `payments.connect-payout-account`, `payments.open-payout-account-link` | `permissions [payments.payout-account.manage]` | `ActorContext.sellerId`; `hasRecentConfirmation`; acting-as refused; seller must be approved (gate column "deny when not approved", as pricing 5.2; Hadi may relax to pending sellers, 16) |
| `payments.view-payout-account` | `permissions [payments.payout-account.view]` | Own seller only |
| `payments.report-payout-account-change` (HP-2, new) | `permissions [payments.payout-account.view]` | Own seller only (`ActorContext.sellerId`); the change id must be that seller's in the context's Market, else byte-identical not-found; acting-as refused; emits `payout-account-change-reported.v1` (consumer C-P) + admin alert + audit (4.6). Recent confirmation applies (protected key, HP-6; no exemption, Ali (2a)); writes `channel = seller-panel`; support uses the next row |
| `payments.report-payout-account-change-for-seller` (Hassan re-check item 1, new) | `permissions [payments.connected-account.close]` | Admin (support); change in the context's Market, else byte-identical not-found; recent confirmation; acting-as refused; same report row with `reported_by_account_id` = admin and `channel = support`, same pause and 14-day cap, same `payout-account-change-reported.v1` (consumer C-P), admin alert, audit (4.6 condition 4); never resolved `owner-confirmed`: ends only by `account-closed` or at the 14-day cap (Hassan HP-1 close-out) |
| `payments.withdraw-payout-account-change-report` (Hassan re-check 2(a), new) | `permissions [payments.payout-account.view]` | Own seller only; unresolved report in the context's Market, else byte-identical not-found; recent confirmation (protected key); acting-as refused; a `support`-channel report → `payments.payout-account.report-not-withdrawable`, nothing written (Hassan HP-1 close-out); writes `owner_withdrawn_at` once; lifts nothing; no event (consumer: the admin queue reads the row); audit `.change-report-withdrawn` + admin alert (4.6 condition 4) |
| `payments.resolve-payout-account-change-report` (Ali (2b), new) | `permissions [payments.connected-account.close]` | Admin; report in the context's Market; recent confirmation; acting-as refused; reason code `owner-confirmed` (only after the owner's withdrawal, Hassan re-check 2(a); never on a `support`-channel report, Hassan HP-1 close-out, data CHECK) or `account-closed` (only on a `CLOSED` account; the pause is kept, 2(b)); resolves once; no event (no named consumer); audit `payments.payout-account.change-report-resolved` (4.6 condition 4) |
| `payments.payout-readiness` | `anonymous` / `system` pair | 4.6; ids only, answer `{ready}`; importers `sellers`, C-P, composition root (P-e) |
| `payments.instruct-transfer`, `payments.instruct-transfer-reversal`, `payments.transfer-by-key`, `payments.abandon-transfer`, `payments.fee-charges-of`, `payments.dispute-of`, `payments.daily-totals-of` | `system` | C-P only (named boundary rule); never elevatable (Ali PC P-a to P-d, P-f, P-h, P-i) |
| `payments.list-payments`, `payments.view-payment` | `permissions [payments.payment.view]` | Market from context |
| `payments.list-disputes`, `payments.view-dispute` | `permissions [payments.dispute.view]` | Market from context |
| `payments.list-connected-accounts`, `payments.view-connected-account` | `permissions [payments.connected-account.view]` | Market from context; seller names composed by the BFF from `sellers` (payments imports nothing of `sellers`) |
| `payments.close-connected-account` | `permissions [payments.connected-account.close]` | Reason code; audit; recent confirmation (HP-6, slice 4); admin alert and the HP-2 notice to the Seller Owner (HP-3); under an open report a live balance read and `payments.connected-account.balance-remaining` while it is not zero (Hassan re-check 2(b)) |
| `payments.edit-settings` (A-5) | `permissions [payments.settings.edit]` | `hasRecentConfirmation`; expected version; acting-as refused |

### 6.3 Default roles (Hadi decides; owner informed, as ordering 5.3)
- Seller: none (both seller keys are protected; the Seller Owner holds them by definition).
- Admin: Finance gets `payments.payment.view`, `payments.dispute.view`, `payments.connected-account.view`; Operations and Support gets `payments.payment.view`; Viewer gets the unprotected view keys. Protected keys (`refund.execute`, `connected-account.close`, `settings.edit`) are granted by the Platform Administrator.

### 6.4 Acting-as and AI
- Every `payments` use case of the customer and seller populations and every protected admin key is refused in an acting-as session until the SEL-08 mini-review decides (fail closed). **Elevation (E3, E4) stays refused in acting-as also after SEL-08** (Hassan, ADR-0038 A4): neither entry has a seller-impersonation use; a relaxation is per entry, through a mini-review with Hassan.
- `payments` publishes no AI tool, is not on the AI import allow-list, and no payment, payout, card or account data reaches a model (ADR-0019 R2, decision 10; brief s3).

### 6.5 Answer codes
`payments.payment-not-found`, `payments.payment.closed`, `payments.unavailable`, `payments.amount-out-of-range`, `payments.currency-mismatch`, `payments.capture.not-authorised`, `payments.refund.exceeds-captured`, `payments.refund.not-captured`, `payments.refund.regime-conflict`, `payments.refund.key-abandoned`, `payments.refund.in-progress`, `payments.transfer.account-not-ready`, `payments.transfer.cooling-off`, `payments.transfer.currency-mismatch`, `payments.transfer.insufficient-platform-balance`, `payments.transfer.provider-refused`, `payments.transfer.exceeds-transferred`, `payments.transfer.amount-out-of-range` (HP-9), `payments.transfer.seller-mismatch` (HP-8), `payments.transfer.account-under-review` (Ali CP-R1 condition 5), `payments.payout-account.confirmation-required`, `payments.payout-account.exists`, `payments.payout-account.report-not-withdrawn`, `payments.payout-account.report-not-withdrawable` (panel withdrawal of a `support`-channel report, Hassan HP-1 close-out), `payments.payout-account.report-resolved` (withdrawal or resolution of a resolved report), `payments.connected-account.balance-remaining`, `payments.connected-account.not-closed` (Hassan re-check 2), `payments.batch.too-large`, `payments.webhook.invalid`, plus `idempotency.key-reused`, `validation.failed`, `conflict.stale`, `conflict.retry`, `access.denied`, `request.throttled`. No answer carries a provider code or message. **HY2 (Hassan; from slice 1):** every database `23xxx` maps to a generic code (`conflict.retry`, or 500 with a correlation id); no `message`/`DETAIL` reaches a client; the Prisma error logger drops `meta`/`DETAIL`; ids and the row's own amounts may appear in server logs only; deployed PostgreSQL runs `log_error_verbosity = terse` without statement parameters (Kazem).

## 7. Boundary

`payments` imports only `contracts/` of `identity` (gate, `hasRecentConfirmation`) and the kernel and `platform/`. **It imports nothing of `ordering`, `sellers`, `commission-payouts`, `tax` or any module that reaches them**, and consumes **no** event from the bus: its only input is the provider webhook (P-6; sellers ruling 3 and M2; Ali G1 ruling 4). The brief s6 subscriptions ("checkout cancelled" from ordering, account deletion from identity) are dropped: `cancelPayment` replaces the first, and `payments` holds no personal data to erase for the second (8, PD13). This is a brief s6 change-log row (17).

```
ordering ──▶ payments ◀── commission-payouts        sellers ──▶ payments (payoutReadiness only)
   ▲ events            ▲ events
   └──── payments events ────┘                       payments ──▶ identity (gate, hasRecentConfirmation)
```
`no-circular` holds transitively: nothing `payments` imports reaches `ordering`, `sellers` or C-P.

### 7.1 Facade files (restricted contract files, each a named rule in `pnpm boundaries` with a failing fixture for every other importer; CODEOWNERS lists Hassan)
| File | Importable by | Methods |
|---|---|---|
| `payments.checkout.ts` | `modules/ordering` | `createPayment`, `capturePayment`, `cancelPayment`, `paymentOf`, `refund`, `refundByKey`, `abandonRefund` |
| `payments.compensation.ts` | `modules/ordering` only (ADR-0035 d5) | `refundCompensation` |
| `payments.payout-execution.ts` | `modules/commission-payouts` only (Ali PC) | P-a `instructTransfer`, P-b `instructTransferReversal`, P-c `transferByKey`, P-d `abandonTransfer`, P-f `feeChargesOf`, P-h `disputeOf`, P-i `dailyTotalsOf` (each ≤ 100 ids where batched). All `system`, never elevatable. `transferResultOf` and `payoutOf` are dropped |
| `payments.payout-readiness.ts` | `modules/sellers`, `modules/commission-payouts` and the composition root (P-e) | `payoutReadiness` |
| `payments.events.ts` | any module | Event schemas (7.2) |

Elevation (ADR-0038): `cancelPayment` (E3) and `paymentOf` (E4) declare themselves elevatable for exactly those entries, **only once ADR-0038 is Accepted** (Ali PC; until then both are plain `system`, and ordering slice 2 / payments slice 3 wait, 14); `capturePayment`, `refundCompensation`, `abandonRefund`, `refundByKey`, `refund` (it already admits the admin), and every method of `payments.payout-execution.ts` declare **never elevatable**. Under ADR-0038 change A1 (opt-in at the target) "never elevatable" is the default for every `system` method; this list stays as documentation and its boundary fixtures stay (H-P6 closed by Hassan).

### 7.2 Events published (ids, enums and instants only; PE 5.3)
| Type | Payload (besides the envelope) | Consumers |
|---|---|---|
| `payments.payment-authorized.v1` | `paymentId`, `orderId` | ordering |
| `payments.payment-failed.v1` | `paymentId`, `orderId`, `reasonCategory`, `declineCount` | ordering |
| `payments.payment-succeeded.v1` (captured) | `paymentId`, `orderId` | ordering (`paidAt` = `occurredAt`; sellers' `firstSaleAt` derives from it through ordering, sellers ruling 1) |
| `payments.payment-capture-failed.v1` | `paymentId`, `orderId`, `reasonCategory` | ordering |
| `payments.payment-cancelled.v1` | `paymentId`, `orderId`, `cause` (`requested`, `decline-cap`, `hold-limit`, `provider`) | ordering |
| `payments.payment-expired.v1` | `paymentId`, `orderId`, `cause` (`window-passed`, `authorisation-lapsed`) | ordering |
| `payments.refund-succeeded.v1`, `payments.refund-failed.v1` | `refundId`, `paymentId`, `orderId`, `kind` (`ret06`, `compensation`, `external`), `key` (absent for `external`), `reasonCategory` (failed only) | ordering |
| ~~`payments.connected-account-status-changed.v1`~~ | — | **Dropped** (no named consumer, ADR-0015; Ali PC) |
| `payments.payout-account-changed.v1` | `connectedAccountId`, `sellerId`, `coolingOffUntil` | **Answered yes (owner, 2026-10-08, Q-P1)**: the fifth email (no bank data, link only, identity-held address, cannot be turned off) is the consumer: the email sender consumes it, so it keeps a named consumer (ADR-0015). C-P does not consume it (readiness is read live). **HP-2:** live mode requires a consumer that sends the out-of-band notice (4.6), whatever Q-P1 says; if it is published, the payload gains `changeKind` (`added`, `updated`, `removed`, `replaced`, `closed`) before the first consumer merges |
| `payments.payout-account-change-reported.v1` (HP-2, new; payments slice 4; emitted by both report entries, seller panel and support; payload unchanged) | `reportId`, `connectedAccountId`, `sellerId` | C-P (system `ADMIN_REVIEW` seller hold + admin task, C-P 3.5) |
| `payments.transfer-executed.v1`, `payments.transfer-failed.v1` | `transferExecutionId`, `instructionKey`, `sellerId`, `reasonCode` (failed) | C-P. `transfer-failed` only after the provider created the transfer (Ali PC); a refusal at creation is synchronous (4.7) |
| `payments.transfer-reversed.v1`, `payments.transfer-reversal-failed.v1` | `transferExecutionId`, `reversalKey`, `sellerId`, `reasonCode` | C-P (both consumed, Ali PC) |
| `payments.payout-paid.v1`, `payments.payout-failed.v1` | `bankPayoutId`, `sellerId`, `reasonCategory` (failed) | C-P (Ali PC: renamed from `payoutId`) |
| `payments.dispute-opened.v1`, `payments.dispute-closed.v1` | `disputeId`, `paymentId`, `orderId`, `outcome` (closed) | C-P (hold, Q5/Q6; amount and `fundsWithdrawn` via `disputeOf`, P-h), admin alerts |
| `payments.dispute-funds-withdrawn.v1`, `payments.dispute-funds-reinstated.v1` (HP-5, new; payments slice 7) | `disputeId`, `paymentId`, `orderId` | C-P (`dispute-debited` / `dispute-reinstated`, C-P 4.10) |
| `payments.fee-charged.v1` | `feeChargeId`, `kind`, `paymentId` / `sellerId` / `disputeId` when related | C-P (Q8; P-f; the dispute fee only here) |

- **No amount in any event** (A-3): the kernel event vocabulary has no money kind (pricing 6.3), and Hassan's code-time check is "event contract snapshots (no amounts, no PII)". Consumers read amounts through the facades (`paymentOf`, `transferByKey`, `feeChargesOf`, `disputeOf`, `dailyTotalsOf`). **Ruled (Ali A-3): no amounts in events**; no kernel `money` kind.
- Events without a named consumer are not published (ADR-0015; Ali PC).
- No provider id, no card field, no actor, no free-string field (contracts test).
- A contracts snapshot test is mandatory; once a consumer merges, a new enum value is a `.v2`.

## 8. Data ownership (for Mojtaba)
`payments` owns, in its own schema: payments, payment attempt outcomes, card display, refund commands, provider commands, connected accounts, payout-account changes, transfer executions, transfer reversals, payout observations, disputes, fee charges, provider events, `payments.outbox`, `payments.inbox` (unused at first; kept for the platform contract). Every row carries `market_id` and `tenant_id`; money is `bigint` + `char(3)` per row (OD-data O1 pattern). Nothing joins another module's tables. **No column can hold card or bank data.**

| # | Input |
|---|---|
| PD1 | `payments`: unique (market, `order_id`); unique (market, provider, provider payment ref); CHECKs `captured ≤ authorised ≤ requested`, `refunded + refund_pending ≤ captured`; `refund_regime` write-once (`none` → one value); status transitions by a guard trigger (3.1), final states frozen |
| PD2 | `provider_commands` and `refund_commands`: unique (market, `key`); `key` CHECK `^[A-Za-z0-9:_-]{1,128}$`; a content fingerprint column; content immutable (guard trigger); state fields only updatable (column grants); `abandoned` final; rows are **never deleted** while the payment exists (the fence must outlive any retry; retention = the financial-record period, CUS-03 / A2) |
| PD3 | The refund unit: lock the `payments` row (version raise) before inserting a `refund_commands` row, so two refunds of one payment serialise on it (the cap). `refund_pending` and `refunded` change only in units that also change a refund row |
| PD4 | `connected_accounts`: at most one non-`closed` row per (market, seller) (partial unique); unique (market, provider account ref); `payout_account_changes` append-only; `cooling_off_until` derived from the latest change |
| PD5 | `provider_events`: unique (market, provider, provider event id); claim index on (market, status, created) and per-object grouping (market, object ref); no body column; prune ≥ 30 days after `applied`/`ignored` |
| PD6 | `transfer_executions`: unique (market, instruction key); `transfer_reversals` unique (market, reversal key); CHECK `reversed ≤ transferred` maintained in one unit |
| PD7 | `payout_observations` unique (market, provider payout ref); `disputes` unique (market, provider dispute ref); `fee_charges` unique (market, provider balance transaction ref), insert-only |
| PD8 | `card_display`: `brand` closed enum and `last4` CHECK `^[0-9]{4}$` **only** (Y1, accepted); the method used is a column of the payment; no other card column exists (no expiry, network or wallet column) |
| PD9 | Reads: `payoutReadiness` for ≤ 100 seller ids in one statement on (market, seller) of non-closed accounts (M2 deadline) |
| PD10 | Admin lists: payments by (market, created desc) with status filter; disputes open first; connected accounts by status |
| PD11 | Jobs: payments in `REQUIRES_PAYMENT` by `expires_at`; `AUTHORISED` by `authorised_at`; refund/provider commands in `SENDING` by `sending_until`; non-final objects for daily reconciliation |
| PD12 | Grants: `INSERT`, `SELECT` everywhere; `UPDATE` only on state, amount-counter, lease and provider-ref columns (provider ref written once); no `DELETE` except the prune of `provider_events` and, by Ali's L7 exception, the platform prune of `outbox` and `inbox` (the only `DELETE` allowed on those two tables; the grant arrives with the platform prune job, as in the other modules) |
| PD13 | Personal data: only `customer_account_id` and `seller_id` (ids). No name, email, address, IP or bank data. Identity's erasure needs no handler; financial retention per CUS-03 / A2 (Ali) |
| PD14 | Audit rows through the platform writer (9); `originating_actor_*` columns of ADR-0038 for E3/E4 calls, **inside the hash-chain canonical row** (Hassan C1 / ADR-0038 A3; `hash_version` 2 if a seal is deployed) |
| PD15 | The cooling-off setting through the ADR-0026 store (Ali A-5), no table of ours |
| PD16 | Provider ref columns: text with per-kind CHECK patterns (`^pi_`, `^re_`, `^acct_`, `^tr_`, `^po_`, `^dp_`, `^txn_` for Stripe; the fake adapter's `^fake_`), so a wrong-kind value cannot be stored; the pattern set is per provider code |
| PD17 | Hassan's conditions (data 3.7, 3.9, 3.11, 3.12): `payout_account_changes.kind` gains `replaced` and the CHECK reads "`initial` only for the seller's first account in the Market" (HP-3); `connected_accounts` gains the external-account HMAC (HP-1.2) and, only under option 2, the payout-pause state (HP-1.1); `transfer_reversals` carries `seller_id` proved against the execution (HP-8); compensation `send_count ≤ 5` (HP-4); dispute `funds_withdrawn` may move false → true once (HP-5) |

## 9. Audit (brief s9)
| Action | Target | Before/after |
|---|---|---|
| `payments.refund.requested`, `.sent`, `.succeeded`, `.failed`, `.refused`, `.abandoned` | refund command | Amount, kind, reason code, key; the admin or `SYSTEM` (compensation) |
| `payments.refund.external-seen`, `payments.refund.fence-breached` | refund command | Amount; alert |
| `payments.payment.cancelled` (hold-limit, decline-cap), `payments.payment.void-after-capture-failure` | payment | Cause |
| `payments.payout-account.connected`, `.link-opened`, `.changed` (VER-10), `.closed` | connected account | State, `coolingOffUntil`; never bank data |
| `payments.transfer.executed`, `.refused`, `.failed`, `.abandoned`, `.reversed`, `.reversal-failed` | transfer | Amount, instruction key, code |
| `payments.dispute.opened`, `.closed` | dispute | Amount, outcome |
| `payments.settings.changed` (A-5) | setting | Old and new value |
| `payments.webhook.mismatch` | provider event | Reason (`livemode`, `foreign-account`); no body |
| `payments.payout-account.change-reported` (HP-2), `.payouts-paused`, `.payouts-resumed` (HP-1 option 2), `.live-check-mismatch` (HP-1.2) | connected account | Change id, `coolingOffUntil`; alert; never bank data |
| `payments.transfer.amount-out-of-range` (HP-9) | transfer instruction | Instruction key; alert |
| `payments.payout-account.change-report-resolved`, `.change-report-withdrawn` (Hassan re-check 2(d)); `.change-reported` records the actor and `channel` (`seller-panel` or `support`, item 1) | change report | Report id, resolution code or withdrawal instant; never bank data |
| `payments.payout-account.payouts-repaused` (re-read check, 2(c)), `.closed-balance-remaining` (2(b)) | connected account | Change or report id when known; alert |
| `payments.transfer.fence-breached` (re-check item 5) | transfer | Instruction key; alert |

Rows written under an elevated context carry the originating actor (ADR-0038 d5). Views of payment lists are not audited (no personal data beyond ids and last 4).

## 10. Idempotency and concurrency
- **Every outbound provider write has a stored key first** (ADR-0035 d3): `orderId`, `capture:<orderId>`, `cancel:<orderId>`, `decline-cap:<paymentId>`, `void-after-capture-failure:<paymentId>`, refund keys, `connected-account:<sellerId>:<n>`, transfer and reversal keys, and under HP-1 option 2 `payout-pause:<changeId>` / `payout-resume:<changeId>`, after a report `payout-pause:<reportId>` / `payout-resume:<reportId>`, and for the re-read check `payout-repause:<providerEventId>` (webhook) or `payout-repause:<connectedAccountId>:<reconcileRunId>` (daily reconciliation) (Hassan re-check 2(c), 2(d)). The same key with other content is refused (`idempotency.key-reused`), checked in our database, not only at Stripe (brief s5).
- **No provider call inside a unit** (PE 6.4): reserve in a unit, call, record in a second unit; a crash repeats the call with the same key (payment-intent commands and compensation refunds; Stripe idempotency 24 h) or is resolved by lookup and the fence (RET-06 refunds and transfers, which `payments` never re-sends: Ali PC, data `send_count ≤ 1`).
- **Isolation: READ COMMITTED everywhere** (ADR-0025; Y9): the fences (`abandonRefund`, `abandonTransfer`) are single-row guarded statements, not `serializable` units; read-only facades open no transaction.
- **Per-payment serialisation:** every unit touching a payment raises its version (refund cap, capture vs cancel). `capture` and `cancel` on one payment cannot both be sent: the second sees the first's command row and answers from it.
- **Pause and resume of one connected account** (HP-1 option 2): sends serialised by a session advisory lock on the account ref; the resume is a guarded clear sent only after it changed one row (4.6 condition 1; data 3.7; Hassan re-check 2(c)).
- **Webhook application** serialises per provider object (5.4) and only moves forward.
- **Decline cap** (P-8): `declineCount` increments in the webhook unit; the cancel is sent after that unit, with key `decline-cap:<paymentId>`.
- **Concurrency tests** (Hassan's code-time list): two refunds racing the cap; capture vs cancel; `abandonRefund` vs a late provider success; `abandonTransfer` vs `instructTransfer` on one key; the restore job vs a new change (guarded clear refuses; the pause is sent after the resume); duplicate and out-of-order webhooks; two transfer instructions with one key and different amounts.

## 11. Where each hard rule is enforced
| Rule (brief s5) | Enforcement point | Test |
|---|---|---|
| Card data never on our servers | No card field in any DTO (contracts test); provider form only; adapter never logs bodies; PD8 columns | Log/DB scan on full fake flows (AC 13) |
| Bank data never stored (VER-10) | No such column (PD4); Stripe-hosted onboarding; webhook handler stores no external-account fields | Contracts + schema test |
| One payment per order; at most one capture | `Payment` invariant + PD1 unique; capture only from `AUTHORISED` | AC 1, AC 3 |
| Manual capture only, no quiet fallback (ADR-0035 d4) | `createPayment` refuses other values; adapter sets `capture_method=manual`; boot refuses a non-card method | Slice 2 test incl. client config (4.1) |
| Command idempotency and same-key/other-content refusal (d3) | `ProviderCommand`/`RefundCommand` fingerprint check in the reserving unit; PD2 unique | AC 3; concurrency tests |
| Webhook authenticity | `verifyWebhook` + `livemode` + account checks before any write (5.2) | AC 2; forged, replayed, stale, wrong-Market tests |
| Results only from provider facts (ADR-0035 d7) | Only `apply-provider-events` and `refresh` move payment state, after a provider re-read | Redirect/claim tests |
| RET-06 admin only; payments re-checks | `payments.refund` rule `permissions [payments.refund.execute]` + acting-as refusal; no other path | AC 6 |
| Refund cap | `RefundCap` in the unit that locks the payment; PD1 CHECK | AC 6 |
| Compensation: system only, full amount, ordering only, exclusive with RET-06 (d5) | `refund-compensation` rule `system`, never elevatable; named boundary rule on `payments.compensation.ts`; `refundRegime` write-once | Boundary fixture; regime tests |
| Fenced abandon (P-7, O-2) | `RefundCommand` states, lease, lookup, `ABANDONED` final + tombstone | Fence tests incl. late success |
| Decline cap (P-8, O-8) | `Payment` decline counter + cancel | Card-testing test |
| No transfer to a not-ready or cooling-off account (Q3, VER-10) | `instructTransfer` checks in the reserving unit | AC 7 |
| Transfer sent at most once; fenced abandon (Ali PC P-d) | `TransferExecution` lease, lookup, `ABANDONED` final + tombstone; data `send_count ≤ 1` | Fence tests incl. late provider success |
| `payments` decides nothing about who is owed | No ledger, schedule or eligibility data in `payments`; C-P only commands | Boundary: no C-P import |
| `payments` imports nothing reaching `sellers` / `ordering` / C-P; consumes no ordering event (P-6) | `pnpm boundaries` + `no-circular`; no subscriber in `presentation/subscribers/` | Boundary fixtures |
| Market from config, no default, no country branch | `PaymentProviderRegistry.forMarket`; webhook path → `MarketContextFactory` | Two fixtures (AC 14) |
| Test mode only until the pen test (Q2) | `LIVE_MODE_ALLOWED` constant; key-prefix and `livemode` checks | Boot tests |
| Money (ADR-0007) | `PaymentAmount`; minor-unit conversion only in the adapter | ZZ (exponent 0) tests |
| No AI | Not on the AI allow-list; no tool | Boundary |
| No silent compensation | Every unmatched provider fact → alert + admin list (`unknown-object`, external refund, fence breach) | AC 5 |

## 12. Jobs (worker, per hosted Market, system actor, scheduler of PE 7)
| Job | Every (proposal) | Does |
|---|---|---|
| `payments.apply-provider-events` | continuous | 5.4 |
| `payments.expire-unconfirmed-payments` | 1 min | 3.1 backstop `EXPIRED` (after a re-read) |
| `payments.release-stale-authorisations` | 5 min | 3.1 hold-limit void + alert |
| `payments.resolve-uncertain-commands` | 1 min | `SENDING` past lease: lookup refunds, transfers and reversals by key; compensation re-send (3.2); RET-06 refunds, transfers and reversals never re-sent (Ali PC): not found → left for the caller's fence (`abandonRefund`, `abandonTransfer`) |
| `payments.reconcile-with-provider` | daily | Re-read every non-final payment, refund, transfer, account and dispute; list the last 3 days of provider events and enqueue missing ones; alert on divergence; the payout-schedule re-read check (4.6 condition 1) and an alert for a `CLOSED` account whose provider balance is not zero (Hassan re-check 2(b)) |
| `payments.collect-connect-fees` | daily | 4.10 |
| `payments.restore-payout-schedules` (HP-1 option 2 only) | 5 min | Accounts not `closed` (a closed account is never restored, Hassan re-check 2(b)) whose payouts are paused and `payouts_paused_until ≤ now` (= `coolingOffUntil`, or under an open "this wasn't me" report the 14-day cap or the admin resolution, 4.6 condition 4): under the account's advisory lock, a guarded clear (`WHERE payouts_paused_until = <value read>`) and, only if it changed one row, restore the Market `connectedPayoutSchedule` (Hassan re-check 2(c); stored key `payout-resume:<changeId>`, or `payout-resume:<reportId>` after a report re-pause), audit; restoring at the cap with the report still open also alerts the admin queue |
| Security alerts (HP-9, HP-18) | hourly (decline-cap rate), daily in `reconcile-with-provider` (transfer total) | Executed transfer total of the day above `dailyTransferAlertThreshold` (HP-9); `declineCapAlertRate` (HP-18; defined per Ali 2026-10-08 (3)): numerator = payments of the Market cancelled with `cause = decline-cap` whose cancellation instant is in the window; denominator = payments of the Market created in the window; window = the trailing hour `[now − 1 h, now)` by the injected `Clock`, evaluated by this hourly job; alert when denominator ≥ `DECLINE_CAP_ALERT_MIN_SAMPLE` (code constant 20, an engineering guard, not a business rule) and numerator / denominator > the rate, compared exactly in decimal (no float); below the minimum sample no ratio alert. **Hassan re-check item 3 (before the Q-A4 PR):** (i) the same ratio is also evaluated over the trailing 24 h `[now − 24 h, now)` by the same hourly job, with the same minimum sample, so a card-tester under 20 payments an hour is still seen; (ii) an absolute trigger `declineCapAlertCount` (`PaymentsPolicy`, per Market, integer ≥ 1, no core default, both fixtures): alert when that many `decline-cap` cancellations fall in the trailing hour, whatever the ratio and the sample; (iii) the rate is a decimal string in the **open** interval `(0, 1)`: boot refuses `0`, `1` and anything outside (a rate of 1 can never be exceeded and would silently disable the alert). Values: rate AU `"0.20"`, ZZ `"0.10"` (Hadi payments and commission-payouts decisions 2026-10-08 (b)); count **proposals for Hadi, not decided:** AU `5`, ZZ `3` (at launch volume, tens of orders a day, five decline-cap cancellations in one hour is not ordinary traffic; ZZ differs so the fixture proves the value is read). Tests: both windows, the count firing below the minimum sample, `0` and `1` refused at boot, both fixtures |

All are safe to run twice or concurrently (keys, unique constraints, forward-only transitions). Provider read volume at launch is small (tens of orders a day); the reconciliation job pages and respects Stripe's rate limits (unverified exact limits; Kazem monitors 429s).

## 13. AI (ADR-0019)
None. `payments` publishes no AI tool, imports nothing of `platform/ai`, is excluded from its allow-list (R2, decision 10), and no payment, card, payout, account or dispute data reaches a model. AIS-14 (payout explanation) stays forbidden as written (brief s3).

## 14. Slices, prerequisites and tests
- **Prerequisites:** kernel `Money` and `allocate`; outbox/inbox, scheduler, audit writer (built); identity `hasRecentConfirmation` (ID-P1) and the permission registry; ADR-0038 Accepted and built (E3, E4) before ordering slice 2 and payments slice 3; the webhook entry adapter (A-1) before slice 2; a Stripe test account under the Market's legal entity (owner action, brief s8); secrets in the secret store (Kazem); `config/markets` values (both fixtures).
- **Order:** brief s11. ADR-0031 decision 5: no placeholder binding of any `payments` facade; consumers wait for the real facade or build against fakes from a contracts-only PR (ADR-0031 d6, Hassan reviews it). Slice 1 ships the contracts files of 7.1 first, so ordering, C-P and sellers can build against the fake adapter. **Every slice needs Hassan's review before merge** (Q2); slices 2, 5 and 6 are in the pen-test scope (webhook, payout-account change, refunds).
- **Slice 6 (refunds) carries P-7**; ordering slice 7 waits for it (O-2). Hassan re-checks O-2, O-3, O-7 against this design in one pass before ordering slice 7 code.
- **Tests:**
  - every domain and integration test runs against AU (`stripe`-shaped config served by the fake adapter) and `ZZ` (JPY, exponent 0, fake provider, different limits and methods);
  - `pnpm verify` uses only the fake adapter: offline and deterministic; a separate `pnpm test:provider` suite runs against Stripe **test mode** with test keys from CI secrets (nightly and before each payments merge), never in `verify`, never with a live key (the suite refuses a non-`sk_test_` key);
  - one test per row of 3.1, 3.2, 3.4, 3.5 and per answer of `cancelPayment` and `abandonRefund`;
  - OD 3.3's compensation rows C1–C12 from the payments side (fake provider scripts: decline to cap, late authorisation, capture failure, capture after void race, timeout-but-done refund);
  - webhook: valid, forged, stale timestamp, rotated secret, duplicate, out of order, wrong `livemode`, foreign account, wrong Market path, unknown type, oversized body;
  - the fence: `abandonRefund` in each state; a provider refund appearing after `ABANDONED` → `refund-succeeded` + alert, cap adjusted, never a second send;
  - card-data scan of DB rows, logs and outbox after full flows; client-secret redaction;
  - 4.1 condition 1: the Payment Element configuration test (`capture_method: manual` present at render);
  - `pnpm boundaries` fixtures: each restricted file imported by another module fails; `payments` importing `sellers`, `ordering`, C-P or `platform/ai` fails; a subscriber in `payments` fails;
  - contracts snapshots of every event (no amount, no provider id, no free string);
  - one test per AC of brief s10;
  - **Hassan's conditions (2026-10-08; log at the end):** F-3 test-mode check and option 1 or 2 (slice 4); HMAC mismatch, failed live read and webhook-delay cases of the pre-transfer check (slice 5); a replacement account cools off (slice 4); pre-send deadline with a fake clock, `maxNetworkRetries: 0`, lease boot checks, a C-P timeout shorter than the lease, list-endpoint lookups with key/destination/amount match, compensation send bound (slices 5, 6); reversal with another seller's execution refused (slice 5); transfer above `maxTransferAmount` (slice 5, both fixtures); inquiry → chargeback → won and → lost (slice 7); breach while a replacement refund is pending (slice 6); `refresh` refused outside entry O-7 (slice 3); return-route access-log redaction (slice 2); reconciliation-enqueued events checked like webhooks, payload account ref ignored (slice 2); `pnpm boundaries` fixture: no file on the `platform/ai` allow-list and no `assistant` file imports a `payments` contract or HTTP client (HP-17, slice 1); **Hassan re-check (2026-10-08):** support report entry with `channel = support`, same pause and event (slice 4); `owner-confirmed` refused without the owner's withdrawal, `account-closed` keeps the pause, close refused while a balance remains, closed account never restored (slice 4); **Hassan HP-1 close-out:** a panel withdrawal of a `support`-channel report refused `payments.payout-account.report-not-withdrawable` and `owner-confirmed` on a `support` report refused by the use case and by `payout_account_change_reports_support_resolution_check`, while `account-closed` and the cap still end it, both fixtures (slice 4); **Ali CP-R1 condition 5:** a transfer to an account with an unresolved report (seller-panel and support) refused `payments.transfer.account-under-review` before reserving, and accepted after `account-closed` on a replacement account or `owner-confirmed`, both fixtures (slice 5); restore job vs a new change (guarded clear), re-read re-pause, Express schedule not editable in the F-3 check (slice 4); NULL HMAC refused, re-stamp mismatch records a change, missing key version → `payments.unavailable`, constant-time compare (slices 4, 5); failed live read never falls back and raises the failure metric (slice 5); quarantine pass by live lookup, with a late transfer found after 15 min → `already-sent` and breach alert (slice 5); 24 h window, `declineCapAlertCount`, rate bounds (Q-A4 PR, slice 3);
  - **pen-test scope** adds (HP-1.5, HP-18): Express Dashboard bank change with a webhook delay and a payout in flight; card-testing velocity in our code (ordering O-8 limits fail closed), not in Radar, whose test-mode behaviour is unverified (F-8).

## 15. Deferred
| Item | When |
|---|---|
| Live mode | After the independent pen test passes (Q2); a reviewed code change (4.11). **Conditions (Hassan):** HP-2 out-of-band notice of every payout-account change (the fifth email, Q-P1 = yes, owner, 2026-10-08), HP-10 Dashboard and key controls, HY1 CHECK removal in the same PR |
| Afterpay and other methods | Owner deferred (Q13); a long approval window revisits ADR-0035 |
| NZ adapter; MY/EU local methods | INTL-40 P2; INTL-41/42 P3 (new adapter + Market config) |
| Instant payouts, saved cards, seller subscriptions | Out of scope (brief s3) |
| Embedded onboarding components instead of hosted links | Later UI decision (Reza); same port |
| Funds segregation (Stripe private preview) | Revisit when generally available (would strengthen Q3 holding) |

## 16. Open questions
**Ali (cto)** — all ruled 2026-10-08 (Ali PC):
- **A-1** Closed: option A (platform webhook entry adapter, own PF-amendment PR, Hassan reviews) (5.1).
- **A-2** Closed: `payments.refund.execute`, `payments`' own key, seeded with `ordering.refund.execute` (6.1).
- **A-3** Closed: no amounts in events (7.2).
- **A-4** Closed: accepted, with the boot check hold-limit > ordering `CAPTURING` `stepMaxAge`; ordering takes OP-1 (3.1).
- **A-5** Closed: ADR-0026 setting under decision 7 (protected key with hard minimum; no ADR), bounds 24 h to 14 days, store error → upper bound, Hassan reviews (4.6).
- **A-6** Closed: brief s6 change-log rows approved, plus a row closing the charge model; ADR-0007 "Amended" note (17).
- Q-A4 (from C-P, applies here too): `PaymentsPolicy` values in their own shared-file PR, board-announced, no core defaults, both fixtures (Mohammad specifies, Hossein builds, Kazem reviews).

**Hassan (security-tester)**
- **H-P1** Webhook design: anonymous receive rule with signature as authentication, no raw body stored, `livemode`/account checks, edge IP allow-list (5).
- **H-P2** The refund fence and the transfer fence (`abandonTransfer`, P-d, reviewed together per Ali PC): lease length vs provider timeout, C-P's `transferSendTimeout` > the lease, lookup by metadata key / `transfer_group`, compensation re-send rule (3.2, 4.7).
- **H-P3** VER-10 with the Express Dashboard: sellers can change bank details at Stripe; we detect and enforce cooling-off after the fact (4.6). **Unverified:** whether Stripe lets a platform stop Express users from editing payout details. If it can, we turn it off.
- **H-P4** Decline cap value (AU 5 per intent) beside ordering's `retry-payment` limits; Stripe Radar rules (unverified for test mode).
- **H-P5** Client secret handling and redaction; publishable key exposure (public by design).
- **H-P6** Never-elevatable list of 7.1 and the restricted contract files.
- **Answered 2026-10-08** (Hassan payments and commission-payouts review 2026-10-08, approved with conditions): H-P1 closed (HP-12, HP-13); H-P2 closed with conditions (HP-4, HP-16); H-P3 re-raised as HP-1 (High) and HP-3; H-P4 closed (HP-18; AU value 5 accepted); H-P5 closed (HP-11); H-P6 closed (ADR-0038 A1, HP-14). Where each HP item sits: log at the end. **Hassan re-checks** HP-1, HP-3, HP-4, HP-8, HP-9 in this text before payments slice 4/5 code and C-P slice 5 code.

**Owner (through Hadi; one decision, the rest informed)**
- **Q-P1 (decision) — ANSWERED yes (owner, 2026-10-08): a fifth email to the Seller Owner, no bank data, link only, identity-held address, cannot be turned off; HP-2 is satisfied by design; `payout-account-changed.v1` has the notifications consumer.** (Question text kept:) VER-10 requires telling the seller when their payout account changes. The owner chose four emails for Phase 5 (Q10). Add a fifth, security email "your payout account was changed", or panel banner only until the notifications module? Affects 4.6 and the consumer of `payout-account-changed.v1` (7.2).
- Informed: eftpos-only Apple Pay cards are hidden and co-branded debit goes over Visa/Mastercard because we authorise before capture (4.1); Express accounts mean the seller also sees a Stripe dashboard (4.6); Stripe states no holding limit for money kept on the platform balance, so the 30-day cap rests on the lawyer's answer, not on Stripe (4.6).

**Hadi**
- May a seller start payout onboarding while still pending approval (6.2)? Default: approved sellers only.
- Default roles of 6.3.

**Commission-payouts G2 (inputs)** — reconciled with C-P's 6.1 (P-a to P-i) under Ali PC
- CPI-1 Commands and refusal codes of 4.7; reads of 7.1; events of 7.2 (C-P consumes transfer (reversal-failed included), bank-payout, dispute and fee events, never payment events: Ali G1 data rule; `connected-account-status-changed` is dropped).
- CPI-2 A failed reversal (insufficient connected balance) is netted by C-P.
- CPI-3 Superseded (Ali PC): no `FAILED (unresolved)`; an uncertain transfer is resolved by `transferByKey` and C-P's fenced `abandonTransfer` (4.7).
- CPI-4 Money held for a seller who never onboards (sellers mini-review open item) stays C-P's policy with the lawyer: answered, staged 30/60/90, the platform never keeps the money (owner, 2026-10-08, Q-O1; C-P 15).

**Sellers**
- **S-P1** Upper bound of `payout-account-grace-days`: no Stripe limit applies to platform-held funds; use 90 days (the conservative Stripe connected-account figure) until the lawyer answers (4.6). Ali PC: 90 days as our policy pending the lawyer; through the sellers mini-review chain.

**Identity**
- **ID-P1** `hasRecentConfirmation` must answer true only when the session re-confirmed with the second factor (Seller Owner), for 4.6; confirm in the identity mini-review that already owns it (ID 8.5).

**Kazem**
- Secrets (API keys, two webhook secrets per Market, rotation), webhook URLs per Market, edge IP allow-list and body limit, Stripe Dashboard access (who may refund or edit there: anything done there appears as `external` and alerts), monitoring of provider 429/5xx.

**Unverified Stripe facts (must be checked before the slice that relies on them)**
- F-1 How Connect account and payout fees and the GST part appear (balance transactions or invoice) (slice 7).
- F-2 Apple Pay web domain registration and wallet behaviour in AU test mode (slice 2).
- F-3 Whether Express users' payout-detail editing can be restricted (slice 4; H-P3). **A gate (HP-1):** verified in test mode before slice 4 merges; outcome option 1 or option 2 of 4.6, plus whether the platform may set `manual` payouts on Express-controller accounts (option 2).
- F-8 Stripe Radar's behaviour in test mode (HP-18; the pen test checks velocity in our code).
- F-4 Exact AU KYC requirements and ABN (brief appendix, still open; affects only Stripe's form).
- F-5 Event retention for Connect events and API rate limits (12).
- F-6 Maximum charge amount for AU (sets `maxPaymentAmount`).
- F-7 Final processing fee figures from the Stripe dashboard (Q8; 1.65% vs 1.7%), and whether manual capture changes them (eftpos routing, 4.1).

## 17. Follow-ups (none in this document's PR)
- `payments` brief change log (Hadi with Ali, mini-review): s6 consumed events removed (P-6); events renamed and added (7.2); s5 state names (3.1); brief s5 "Stripe charge model" closed.
- ADR-0007: "Amended" note closing the charge-model line (separate charges and transfers), in the shared-docs PR.
- PF amendment for the webhook entry adapter (A-1 = A; small shared-file PR, board-announced; Mohammad, Hassan reviews).
- `PaymentsPolicy` Market-config section: its own shared-file PR (Q-A4; Mohammad specifies, Hossein builds, Kazem reviews; board).
- ordering: OP-1 (`payment-cancelled`/`payment-expired` recorded on a `REVIEW` item); OD-data P1 closed (events carry `orderId`).
- `technical-spec.md` lines 195–196 and 292 (card storage wording, brief conflict 2) in the shared-docs PR.

## 18. Review record
| Date | Reviewer | Result |
|---|---|---|
| 2026-10-08 | Mohammad | Draft |
| 2026-10-08 | Mojtaba (`docs/design/data/payments.md`) | Data design written; Y1, Y4, Y9 accepted and applied here (Y2, Y3, Y5 to Y12 as in the data design) |
| 2026-10-08 | Ali (Ali payments and commission-payouts review 2026-10-08) | Approve with changes; A-1 to A-6 ruled; facade list P-a to P-i applied (reconciliation log) |
| 2026-10-08 | Hassan (Hassan payments and commission-payouts review 2026-10-08; mandatory, tier A) | **Approved with conditions**; HP-1 and HP-2 High. Conditions written in (security conditions log); re-check of HP-1, HP-3, HP-4, HP-8, HP-9 pending before slice 4/5 code |
| 2026-10-08 | Owner (Q-P1, through Hadi;) | Q-P1 answered yes (owner, 2026-10-08): fifth email, `payout-account-changed.v1` consumer; HP-2 satisfied by design (4.6, 7.2, 15) |

## Appendix A. Stripe sources read 2026-10-08
| Fact used | Source |
|---|---|
| Manual capture; authorisation windows (CIT online 7 days for Visa, Mastercard, Amex, Discover; Visa MIT 4 d 18 h); expiry → `canceled`; `capture_before`; full capture by default, one capture | `docs.stripe.com/payments/place-a-hold-on-a-payment-method` |
| Apple Pay and Google Pay: manual capture supported, no separate API enum, Connect supported | `docs.stripe.com/payments/payment-methods/payment-method-support` |
| eftpos: no manual capture; holds routed to the international scheme; eftpos Apple Pay fails with manual capture; set `capture_method: manual` at Element render | `docs.stripe.com/payments/eftpos-australia` |
| Separate charges and transfers available in AU; same-region rule; platform balance debited for fees, refunds, chargebacks; `transfer_group`; `source_transaction`; failed transfers not retried; reversals need the connected balance | `docs.stripe.com/connect/separate-charges-and-transfers` (Payment Intents variant) |
| Manual payouts must be paid within 90 days outside US/TH; Stripe provides no escrow | `docs.stripe.com/connect/manual-payouts` |
| Controller properties; Express mapping; dashboard type immutable; `none` unsupported with `requirement_collection=stripe` + `losses=application` | `docs.stripe.com/connect/migrate-to-controller-properties` |
| Full vs recipient service agreement (recipient: transfers only, +24 h availability, select countries; AU availability unverified) | `docs.stripe.com/connect/service-agreement-types` |
| Idempotency keys ≤ 255 characters, pruned after 24 h, parameter mismatch errors, no saved result if execution never began | `docs.stripe.com/api/idempotent_requests` |
| Webhook signature, 5-minute tolerance, retries, ordering, IP allow-list; Connect destinations; fees; payouts schedule | brief appendix A (read 2026-10-07) |

## Reconciliation log (2026-10-08)
Mohammad, with Mojtaba's `docs/design/data/payments.md` open. Inputs: Ali payments and commission-payouts review 2026-10-08 (Ali PC), Mojtaba notes 2026-10-08, payments design notes 2026-10-08, commission-payouts design notes 2026-10-08, Hadi G2 decisions 2026-10-08.

| Item | Applied where / how |
|---|---|
| Ali PC P-a | 2.1 `TransferExecution` (`reference`, no description); 4.7 `instructTransfer` → `accepted {transferExecutionId}` / `refused {code}` / `payments.unavailable`; 6.2, 7.1 |
| Ali PC "Stripe 4xx on transfer = synchronous refused; `transfer-failed.v1` only post-creation" | 2.4 row 3; 3.5; 4.7 refusal codes (`insufficient-platform-balance`, `provider-refused`); 6.5; 7.2 |
| Ali PC "no self-initiated transfer re-send (lookup then fence)" | 2.1; 3.5; 4.7; 10; 11 (new row); 12 `resolve-uncertain-commands`; 16 CPI-3 superseded |
| Ali PC P-b | 4.7 (unknown outcome by key lookup; `transfer-reversal-failed.v1` consumed by C-P); 7.2 |
| Ali PC P-c `transferByKey` (replaces `transferResultOf`) | 4.7, 6.2, 7.1, 7.2 note |
| Ali PC P-d `abandonTransfer` | 2.1 (tombstone), 3.5, 4.7 (answers, lease, `transferSendTimeout` > lease), 9 audit, 10 tests, 11; Hassan with H-P2 (16) |
| Ali PC P-e `payoutReadiness` importers | 4.6, 6.2, 7.1 (sellers, C-P, composition root) |
| Ali PC P-f | 4.7, 4.9, 4.10, 7.2 (kind names; `orderId`; dispute fee only here) |
| Ali PC P-g, `bankPayoutId` rename | 2.1 tree and table, 3.6, 4.8, 7.2 (`payout-paid/-failed.v1` carry `bankPayoutId`); `payoutOf` dropped (4.8, 7.1) |
| Ali PC P-h, `fundsWithdrawn` | 2.1 `Dispute`; 3.3 (inquiry withdraws nothing, no debit); 4.7; 4.9; 7.2 |
| Ali PC P-i `dailyTotalsOf` | 4.7, 6.2, 7.1, 7.2 note |
| Ali PC "events without named consumer dropped" | 3.4, 7.2 (`connected-account-status-changed.v1` dropped; `payout-account-changed.v1` consumer fixed by Q-P1 = yes) |
| Ali PC E3/E4 depend on ADR-0038 Accepted | 7.1 elevation paragraph |
| Ali A-1 to A-6 | 3.1 (A-4), 4.6 (A-5), 5.1 (A-1), 6.1 (A-2), 7.2 (A-3), 16 (all closed), 17 (A-6) |
| Ali Q-A4 | 16, 17 (`PaymentsPolicy` PR, both fixtures, no core default) |
| Ali S-P1 / 90-day bound | 4.6, 16 S-P1 (our policy pending the lawyer; Hadi decision 4 default 30 days) |
| Mojtaba Y1 (brand + last 4 only) | 2.1 tree and `Payment` row (`paymentMethodUsed`), 4.5, PD8 |
| Mojtaba Y4 (authorised above request not storable) | 3.1 row `REQUIRES_PAYMENT → AUTHORISED` (event `dead`, alert, void; key name with Mojtaba in slice 3) |
| Mojtaba Y9 (READ COMMITTED fences) | 3.2 `abandonRefund` row, 4.7 `abandonTransfer`, 10 |
| Ali L7 (prune exception) | PD12: outbox/inbox platform prune is the only `DELETE` on those tables |
| Hadi decision 1 (refund key seeded to finance admin) | 6.1 |
| **Left open** | Q-P1 (answered yes, owner, 2026-10-08); H-P1 to H-P6 and Hassan's data items HY1 to HY3 (Hassan); F-1 to F-7 (unverified Stripe facts, per slice); Y4 void key name (Mojtaba, slice 3) |

## Security conditions log (Hassan, 2026-10-08)
Mohammad, from Hassan payments and commission-payouts review 2026-10-08 (verdict: approved with conditions; HP-1, HP-2 High). Gates as Hassan's section 5. "Re-check" = Hassan reads the text before the named code starts.

| Item | Where in this document | Gating slice |
|---|---|---|
| HP-1 (High) F-3 gate, option 1 or 2 | 2.4 row 2; 4.6 HP-1 condition 1; 10 keys; 12 `restore-payout-schedules`; 16 F-3 | F-3 verified before **slice 4 merges**; design re-check before slice 4/5 code and C-P slice 5 code |
| HP-1 pre-transfer live check (HY3) | 4.6 condition 2; 4.7 | Slice 5 (HMAC column with slice 4) |
| HP-1 pen-test scope | 4.6 condition 5; 14 | Pen test (live mode) |
| HP-2 (High) out-of-band notice | 4.6 condition 3; 4.11; 7.2; 15 | **Live mode**, independent of Q-P1 (Q-P1 answered yes; satisfied by design) |
| HP-2 "this wasn't me" | 4.6 condition 4; 6.2; 7.2 (`payout-account-change-reported.v1`, owner `payments`, consumer C-P); 9 | Payments slice 4; C-P slice 5 (hold); live mode at the latest |
| HP-3 replacement account | 3.4; 4.6; 6.2; PD17 | Before slice 4 code (re-check) |
| HP-4 fence conditions | 3.2 items 1 to 6; 14 | Re-check before slice 4/5 code; built in slice 5 (transfers, reversals) and slice 6 (refunds) |
| HP-5 dispute funds after opening | 3.3; 7.2 (two events, consumer C-P); PD17 | Payments slice 7 / C-P slice 6 |
| HP-6 protected = recent confirmation | 4.4; 6.2 | Slice 6 (`refund`), slice 4 (`close-connected-account`) |
| HP-7 | C-P only (C-P 4.11) | C-P slice 6 |
| HP-8 reversal bound to the seller | 4.7 P-b; 6.5; PD17 | Re-check before C-P slice 5; code payments slice 5, C-P slice 6 |
| HP-9 transfer ceiling, daily alert | 2.2; 4.7; 6.5; 9; 12 | Re-check before slice 5 code; slice 5 |
| HP-10 Dashboard, restricted key | 4.11; 15 | Live mode |
| HP-11 return URL | 4.2; 4.11 | Slice 2 |
| HP-12 webhook details | 5.2; 5.4; 14 | Slice 2 |
| HP-13 PF entry adapter | 5.1 | PF-amendment PR |
| HP-14 `refresh` only for O-7 | 6.2 | Before payments slice 3 / ordering slice 2 (with ADR-0038) |
| HP-15 | C-P only (C-P 5.2) | C-P slices 5, 6 |
| HP-16 breach vs pending replacement | 3.2 item 7 | Slice 6 |
| HP-17 reverse AI import | 14 (boundaries fixture) | Slice 1 |
| HP-18 card testing | 12 alert; 14; 16 F-8; ordering O-8 limits fail closed | Payments slice 3 (alert); ordering slice 2 (limits); pen test |
| HP-19 onboarding links | 2.2; 4.6 | Slice 4 |
| Q-S1 to Q-S4 | C-P (5.1, 4.7, 4.11, 5.4) | C-P slices |
| HY1 `livemode` CHECK | 4.11; 15 | Slice 2 (Y2); removal in the live-mode PR |
| HY2 error messages | 6.5 | Slice 1 onward; Kazem for deployed PostgreSQL |
| Ali A-5 accepted | 4.6 | Slice 4 |
| Acting-as refusal of elevation | 6.4; ADR-0038 A4 | Before payments slice 3 |
| C1 audit columns in the hash chain | PD14; ADR-0038 A3 | Elevation PR (before ordering slice 2 / payments slice 3) |
| ADR-0038 A1 to A4 | 7.1; ADR draft | ADR Accepted before payments slice 3 / ordering slice 2 |
| Still owed elsewhere | ID-P1 mini-review before slice 4; ID-3 before C-P slice 5 | — |

### Re-check items applied (Hassan, Hassan re-check 2026-10-08, 2026-10-08)
Mohammad, with Mojtaba for `docs/design/data/payments.md`. Text only; Hassan re-checks it with no new review round (HP-1 still open and High until he does).

| Re-check item | Where in this document (data) | Gating |
|---|---|---|
| 1 Support entry `payments.report-payout-account-change-for-seller` (owner `payments`; event consumer C-P), `channel` code, support contact in Market config | 2.2 (`payoutAccountSupportContact`); 4.6 conditions 3, 4; 6.2; 7.2; 9 (data 3.7 `channel`) | Payments slice 4; contact text before live mode (HP-2) |
| 2(a) `owner-confirmed` only after the owner's withdrawal; `payments.withdraw-payout-account-change-report` (owner `payments`; no event, consumer the admin queue) | 4.6 condition 4; 6.2; 6.5; 9 (data 3.7 `owner_withdrawn_at` CHECKs) | Payments slice 4 |
| 2(b) `account-closed` keeps the pause; no restore of a closed account; balance recovered by C-P reversal before close; closed-balance alert | 4.6 condition 4; 6.2; 6.5; 9; 12 (data 3.7 index and trigger); C-P 4.11 `payout-account-compromised` | Payments slice 4; C-P slice 6 (reversal) |
| 2(c) advisory lock per account, guarded clear, re-read re-pause, Express schedule in F-3 | 4.6 condition 1; 10; 12 (data 3.7) | Payments slice 4 (F-3 before it merges) |
| 2(d) `<reportId>` keys; resolution and withdrawal audit actions | 10; 9 | Payments slice 4 |
| 3 24 h window, `declineCapAlertCount` (no core default; AU 5, ZZ 3 proposals for Hadi), rate in `(0, 1)` | 2.2; 12 | **Q-A4 PR** (blocks it) |
| 4 No fallback to stored state; failed-read alert | 4.6 condition 2 | Payments slice 5 |
| 5 HP-4 quarantine as a live provider list lookup through `abandonTransfer` on an `ABANDONED` key (`still-abandoned` / `already-sent` / `payments.unavailable`); fence breach `ABANDONED → EXECUTED` | 3.2 item 5; 3.5; 4.7 P-c, P-d; 9 (data 3.8 `fence_breached_at`); C-P 3.6, 11 | **Payments slice 5 and C-P slice 5 code** |
| 6 HMAC re-stamp only on a match under the stored version; NULL never matches; missing key → unavailable; same-version change only with a change row; constant time | 4.6 condition 2 (data 3.7) | **Payments slice 4/5 code** (HP-1) |
| HP-1 close-out 2(a) (Hassan HP-1 close-out 2026-10-08): a `support`-channel report is never resolved `owner-confirmed` (ends only by `account-closed` or the 14-day cap); answer `payments.payout-account.report-not-withdrawable`; support runbook: recall and close within the cap (informational) | 4.6 condition 4; 6.2; 6.5; 14 (data 3.7 `payout_account_change_reports_support_resolution_check`, specified, not measured) | Payments slice 4; Hassan checks these lines (no new round); HP-1 open until he does, blocking payments slice 4/5 and C-P slice 5 code |
| Ali CP-R1 condition 5 (Ali ruling CP-R1 2026-10-08): no transfer while a report is open, `payments.transfer.account-under-review` | 4.7; 6.5; 14 | Payments slice 5; Hassan re-checks with HP-1 and C-P condition 6 |
| Unchanged | F-3 before slice 4 merges; ID-P1 before slice 4; ID-3 before C-P slice 5; HP-2, HP-10 before live mode | — |
