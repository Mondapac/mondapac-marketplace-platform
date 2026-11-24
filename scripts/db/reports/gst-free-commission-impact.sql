-- Read-only impact report: commission posted on tax-inclusive order lines with a flat provisional
-- tax rate instead of the line's own frozen rate (a GST-free line, rate 0, had 10 % taken out of
-- its base, so the platform took LESS commission than the approved rule). Changes nothing.
--
-- An ops report, exempt from the no-cross-schema-join rule (it reads ordering and
-- commission_payouts side by side). Run it with a read-only role on a replica, or off-peak:
--   psql "$READ_ONLY_DATABASE_URL" -v market=AU -v provisional=1000 \
--     -f scripts/db/reports/gst-free-commission-impact.sql
-- `market` is one Market id; `provisional` is that Market's commissionPayouts.provisionalTaxRateBps
-- (AU: 1000). Run once per Market.
--
-- Rounding is the ledger's: half up, base = gross * 10000 / (10000 + tax), commission = base * rate.
-- Known limits: the exclusive-customer saved_amount is not recomputed; "already paid out" is per
-- seller order (a payout holds whole seller orders), not per line.

\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';
SET LOCAL work_mem = '64MB';

\echo '== Totals per currency and tax rate (only lines whose commission differs) =='
WITH lines AS (
  SELECT e.market_id, e.seller_id, e.seller_order_id, e.order_line_id, e.currency, e.rate_bps,
         l.tax_rate_bps, l.tax_category_code,
         e.amount AS posted_commission,
         -- The ledger line amount: after the seller's share of the discount (owner Q2/Q3).
         CASE WHEN l.tax_rate_bps = 0 THEN l.line_amount - l.discount_seller_share
              ELSE ((l.line_amount - l.discount_seller_share) * 10000 * 2 + (10000 + l.tax_rate_bps))
                   / ((10000 + l.tax_rate_bps) * 2)
         END AS correct_base
  FROM commission_payouts.ledger_entries e
  JOIN ordering.order_lines l ON l.market_id = e.market_id AND l.id = e.order_line_id
  WHERE e.market_id = :'market' AND e.kind = 'commission'
    AND l.tax_inclusive AND l.tax_rate_bps IS NOT NULL AND l.tax_rate_bps <> :'provisional'::int
), diff AS (
  SELECT g.*,
         (g.correct_base * g.rate_bps * 2 + 10000) / 20000 - g.posted_commission AS commission_gap,
         COALESCE((SELECT sum(r.amount) FROM commission_payouts.ledger_entries r
                   WHERE r.market_id = g.market_id AND r.seller_order_id = g.seller_order_id
                     AND r.order_line_id = g.order_line_id AND r.kind = 'refund-commission'), 0)
           AS commission_refunded,
         EXISTS (SELECT 1 FROM commission_payouts.payout_items i
                 JOIN commission_payouts.payouts p ON p.market_id = i.market_id AND p.id = i.payout_id
                 WHERE i.market_id = g.market_id AND i.seller_order_id = g.seller_order_id
                   AND i.freed_at IS NULL
                   AND p.state IN ('instructing', 'instructed', 'paid', 'settled-by-netting'))
           AS already_paid_out
  FROM lines g
)
SELECT currency, tax_rate_bps, tax_category_code,
       count(*)                                           AS lines,
       count(DISTINCT seller_id)                          AS sellers,
       sum(posted_commission)                             AS posted_commission,
       sum(commission_gap) FILTER (WHERE commission_gap > 0)  AS under_charged_before_refunds,
       sum(-commission_gap) FILTER (WHERE commission_gap < 0) AS over_charged_before_refunds,
       sum(commission_gap) FILTER (WHERE already_paid_out)    AS gap_in_sent_payouts,
       count(*) FILTER (WHERE commission_refunded > 0)        AS lines_with_refunds
FROM diff WHERE commission_gap <> 0
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo '== Per seller, largest gap first (before refunds) =='
WITH lines AS (
  SELECT e.seller_id, e.seller_order_id, e.currency, e.rate_bps, e.amount AS posted_commission,
         CASE WHEN l.tax_rate_bps = 0 THEN l.line_amount - l.discount_seller_share
              ELSE ((l.line_amount - l.discount_seller_share) * 10000 * 2 + (10000 + l.tax_rate_bps))
                   / ((10000 + l.tax_rate_bps) * 2)
         END AS correct_base
  FROM commission_payouts.ledger_entries e
  JOIN ordering.order_lines l ON l.market_id = e.market_id AND l.id = e.order_line_id
  WHERE e.market_id = :'market' AND e.kind = 'commission'
    AND l.tax_inclusive AND l.tax_rate_bps IS NOT NULL AND l.tax_rate_bps <> :'provisional'::int
), diff AS (
  SELECT g.*, (g.correct_base * g.rate_bps * 2 + 10000) / 20000 - g.posted_commission AS commission_gap
  FROM lines g
)
SELECT seller_id, currency, count(*) AS lines, count(DISTINCT seller_order_id) AS seller_orders,
       sum(commission_gap) AS commission_gap
FROM diff WHERE commission_gap <> 0
GROUP BY 1, 2 ORDER BY commission_gap DESC LIMIT 50;

\echo '== Lines placed before tax rates were frozen (left on the provisional rate) =='
SELECT count(*) AS lines
FROM commission_payouts.ledger_entries e
JOIN ordering.order_lines l ON l.market_id = e.market_id AND l.id = e.order_line_id
WHERE e.market_id = :'market' AND e.kind = 'commission' AND l.tax_inclusive AND l.tax_rate_bps IS NULL;

ROLLBACK;
