# commission-payouts: build notes (speed mode)

What is built so far and the rules it keeps. Under speed mode there is no separate G2 design for
these slices; the brief (`brief.md`) and the data design (`docs/design/data/commission-payouts.md`)
stay the long-term target.

## Seller ledger (`commission_payouts.ledger_entries`)

Insert-only (a trigger refuses UPDATE, DELETE and TRUNCATE for every role; the application role
holds only SELECT and INSERT). One row per money fact of a seller, with a non-negative `amount` in
minor units; the kind gives the direction. `market_id` and `tenant_id` are on every row.

| Kind | Direction | Line | Source | Written by |
|---|---|---|---|---|
| `sale` | credit | yes | none | paid seller order (package 5) |
| `shipping` | credit | no | none | paid seller order, non-zero fee |
| `commission` | debit | yes | none | paid seller order; carries `rate_bps` and `base_amount` |
| `refund-sale` | debit | yes | refund id | succeeded refund the seller bears (package 6a) |
| `refund-shipping` | debit | no | refund id | same, for a shipping part |
| `refund-commission` | credit | yes | refund id | same; carries the original `rate_bps` and the base reversed |
| `dispute-debit` | debit | no | dispute id | not written yet: allowed by the CHECK for the disputes package |
| `dispute-reinstate` | credit | no | dispute id | not written yet |

Balance = sales + shipping − commission − refunded sales − refunded shipping + refunded
commission − dispute debits + dispute reinstated. It may be negative. The seller and admin ledger
endpoints return these totals beside the rows.

The unique key is `(market_id, seller_order_id, kind, order_line_id, source_id)` NULLS NOT
DISTINCT. Several partial refunds of one line each get their own rows (their own `source_id`), and
a replay of the same refund conflicts and writes nothing (`INSERT ... ON CONFLICT DO NOTHING`).

## Refund reversals (package 6a)

- Admin refunds live in `ordering` (`ordering.refunds`). The admin names who bears the loss:
  `lossBearer` `seller` (default) or `platform`; `platform` needs `lossReasonCode` (`platform-error`,
  `carrier-loss`, `seller-unrecoverable`, `fraud-loss`, `goodwill`, `other`), `seller` takes none.
  Both are stored on the refund and in its audit entry.
- The worker job `ordering.record-refund-ledger` takes succeeded refunds not yet recorded, only
  once the seller order's paid facts are in the ledger (otherwise the refund waits), and calls
  `COMMISSION_PAYOUTS_FACADE.recordRefund` with ids and numbers only (refund, seller order, per
  line the units before and now, the shipping charge refunded before and after). A refusal is
  counted on the refund (`ledger_attempts`); at 5 it is reported once. The refund is marked
  (`ledger_recorded_at`) when the ledger wrote it, had already, or had nothing to write.
- `platform` bears the loss: nothing is posted, the seller keeps its full share (owner decision
  Q-O2). `seller`: per refunded line a `refund-sale` and a `refund-commission` row, and for a
  shipping part a `refund-shipping` row.
- Every amount comes from the stored ledger rows of the seller order, never from a price or a
  rate. Cumulative proportional reversal (`domain/reversal.ts`):
  `reversed(u) = round_half_up(rowAmount × u / lineQuantity)`, and a refund posts
  `reversed(unitsBefore + units) − reversed(unitsBefore)`. Refunding every unit over any sequence
  of partial refunds therefore reverses exactly the original row, in whatever order they are
  posted. The shipping row is reversed the same way over the shipping charge the customer paid.
  Sale and shipping rows keep the basis they were written in (a tax-inclusive line is reversed
  inclusive, an exclusive one exclusive). A share that rounds to zero writes no `refund-sale` or
  `refund-shipping` row; a `refund-commission` of 0 is still written.

`base_amount` on a `refund-commission` row is **informational**: when a commission share and its base round independently, the base can come out below the commission, and the ledger raises it to the commission so the row still satisfies `amount <= base_amount`. The bases of one line's reversals may therefore sum to slightly more than the original base. Never sum it, and never use it as the tax base of a reversal: tax is reversed from the originals, not from this column.

The ledger step also caps itself: the `refund-*` rows of other refunds plus this one never exceed the stored `sale`, `commission` or `shipping` row, and a refunded line with no stored rows is refused; both answer `commission-payouts.ledger-inconsistent` and write nothing. The shipping position (`shipping_before`) is stored on the refund when it is written, like `units_before`.

## Package 6d: the seller payout run

Design: G2 section 3.6 (state machine), 4.5 to 4.7 (planning, gate, run), 11 (reconciliation).

**Jobs** (one pass per hosted Market, rule `system`)
- `commission-payouts.payout-run`, every 15 minutes. Revalidates the payouts that wait
  (AWAITING_APPROVAL, APPROVED), then evaluates the sellers whose slot is due (at most 5 batches of
  100). Each write unit locks the seller's cursor first and plans again from the committed state.
  Each payout that becomes INSTRUCTING is sent right after its unit commits, after one more
  `access.eligible` check (4.7 step 5); anything but a clear yes fences the key and closes the
  payout as NOT_SENT `payout-unwound` (no quarantine, nothing was sent).
- `commission-payouts.reconcile-instructions`, every 5 minutes. Asks payments by key. A key payments
  never saw is sent by this job after the same re-check. After twice the send lease the key is
  fenced (`abandonTransfer`); after 15 minutes it is asked once more and closed as NOT_SENT.
- Consumer of `payments.transfer-changed.v1`: a trigger only; the payout follows the state read by key.

**Routes**
- Admin (`commission-payouts/admin/payouts`): list, view, and `POST :payoutId/approve` (protected,
  step-up, echoes the transfer amount; approval binds the amount).
- Seller (`commission-payouts/seller`): `payouts/next`, `payouts`, `payout-holds`. The seller id comes
  from the session only.

**Rules worth knowing**
- One live payout per seller (partial unique index). One unfreed item per seller order.
- An APPROVED payout is planned again before it is instructed and voided when a hold, a lower
  seller order, a failed check or a different transfer amount (receivable grew) is found.
- Reconcile and the transfer-changed consumer settle a payout only on a transfer of its own amount
  and currency; any other record under the key raises PayoutAlert `transfer-unmatched` and changes
  nothing.
- `idempotency.key-reused` is not a definite refusal: the payout stays INSTRUCTING and a PayoutAlert
  is raised.
- Dispute holds and decisions take the affected sellers' cursor locks first (sellerId order).
- The table guards: `instructing_at` and `abandoned_at` are written once, the transfer id only with
  instructing to instructed, and a payout can only be inserted as pending, awaiting-approval,
  instructing or settled-by-netting.
- Against a non-test Stripe key the unwired prerequisites adapter answers `unavailable`: the run pays
  nothing until a real second-factor / business-id adapter exists.

**Open items** (also in the pull request)
1. No facade for the owner's second factor or the business-id re-check; the adapter answers ok in
   test mode (closed against the live provider). Hard gate before live money.
2. `lastBankChangeAt` is null (payments' cooling-off covers the money path).
3. Readiness shown to the seller comes from the cursor's last evaluation.
4. No payable / in-transit journal accounts, so no daily reconciliation yet. Before live money.
5. No approval expiry.
6. A transfer above `maxTransferAmount` becomes NOT_SENT with an alert; it is not split.
7. (closed) Dispute decisions and holds now take the cursor lock.
8. (closed) A net increase after approval now voids the approved payout; after an item was taken
   (not approved) it is still ignored: the seller is paid less, never more.
9. `transfer-after-abandon` posting is not built: a late transfer for a NOT_SENT payout is retried to
   dead-letter and alerts. Before live money.
10. NOT_SENT or VOIDED money is proposed again (by design); safe only with 9.
11. Acting-as is tested on the helper and by the exact 401 in the e2e.
12. Access check uses `sellers.sellingEligibility` per seller instead of `accessStatesForPayout` +
    `PayoutAccessMapping` (not built); the batch "any anomaly drops the batch" rule is applied
    per payout, right before the send. Needs sign-off from Ali.
13. The run evaluates at most 500 sellers per tick; `listByState(..., 100)` reads oldest first, so a
    backlog above 100 delays newer payouts (liveness, not money).
14. `payout_state_history` is not built: a payout's transitions are kept only as its current state,
    `state_changed_at` and the timing columns.
15. The events `payout-instructed.v1` and `payout-status-changed.v1` (design 6.3) are not published.
