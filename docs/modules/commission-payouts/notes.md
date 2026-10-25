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
