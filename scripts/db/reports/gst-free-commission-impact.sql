-- Read-only impact report: commission posted on tax-inclusive order lines with a flat provisional
-- tax rate instead of the line's own frozen rate (a GST-free line, rate 0, had 10 % taken out of
-- its base, so the platform took LESS commission than the approved rule). Changes nothing.
--
-- Run with a role that can read both schemas (the migrator), for example:
--   psql "$MIGRATION_DATABASE_URL" -v provisional=1000 -f scripts/db/reports/gst-free-commission-impact.sql
-- `provisional` is the Market's commissionPayouts.provisionalTaxRateBps (AU: 1000).
--
-- Rounding is the ledger's: half up, base = gross * 10000 / (10000 + tax), commission = base * rate.

\set ON_ERROR_STOP on
-- Only session-local temp views are created, inside a transaction that is rolled back.
BEGIN;

CREATE TEMP VIEW gst_commission_lines AS
SELECT
  e.market_id,
  e.seller_id,
  e.seller_order_id,
  e.order_line_id,
  e.currency,
  e.rate_bps,
  l.tax_rate_bps,
  l.tax_category_code,
  e.base_amount                                   AS posted_base,
  e.amount                                        AS posted_commission,
  -- The ledger line amount: after the seller's share of the discount (owner Q2/Q3).
  (l.line_amount - l.discount_seller_share)       AS ledger_line_amount,
  CASE
    WHEN l.tax_rate_bps = 0 THEN (l.line_amount - l.discount_seller_share)
    ELSE ((l.line_amount - l.discount_seller_share) * 10000 * 2 + (10000 + l.tax_rate_bps))
         / ((10000 + l.tax_rate_bps) * 2)
  END                                             AS correct_base
FROM commission_payouts.ledger_entries e
JOIN ordering.order_lines l
  ON l.market_id = e.market_id AND l.id = e.order_line_id
WHERE e.kind = 'commission'
  AND l.tax_inclusive
  AND l.tax_rate_bps IS NOT NULL
  AND l.tax_rate_bps <> :provisional;

CREATE TEMP VIEW gst_commission_diff AS
SELECT g.*,
       (g.correct_base * g.rate_bps * 2 + 10000) / 20000           AS correct_commission,
       (g.correct_base * g.rate_bps * 2 + 10000) / 20000 - g.posted_commission
                                                                   AS under_charged,
       COALESCE((SELECT sum(r.amount) FROM commission_payouts.ledger_entries r
                 WHERE r.market_id = g.market_id AND r.seller_order_id = g.seller_order_id
                   AND r.order_line_id = g.order_line_id AND r.kind = 'refund-commission'), 0)
                                                                   AS commission_refunded,
       EXISTS (SELECT 1 FROM commission_payouts.payout_items i
               JOIN commission_payouts.payouts p
                 ON p.market_id = i.market_id AND p.id = i.payout_id
               WHERE i.market_id = g.market_id AND i.seller_order_id = g.seller_order_id
                 AND p.state IN ('instructing', 'instructed', 'paid', 'settled-by-netting'))
                                                                   AS already_paid_out
FROM gst_commission_lines g;

\echo '== Totals per Market, currency and tax rate =='
SELECT market_id, currency, tax_rate_bps, tax_category_code,
       count(*)                       AS lines,
       count(DISTINCT seller_id)      AS sellers,
       sum(posted_commission)         AS posted_commission,
       sum(correct_commission)        AS correct_commission,
       sum(under_charged)             AS under_charged,
       sum(under_charged) FILTER (WHERE already_paid_out) AS under_charged_already_paid_out,
       count(*) FILTER (WHERE commission_refunded > 0)    AS lines_with_refunds
FROM gst_commission_diff
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

\echo '== Per seller (largest first) =='
SELECT market_id, seller_id, currency,
       count(*) AS lines,
       sum(under_charged) AS under_charged,
       sum(under_charged) FILTER (WHERE already_paid_out) AS already_paid_out
FROM gst_commission_diff
GROUP BY 1, 2, 3
ORDER BY under_charged DESC
LIMIT 50;

\echo '== Lines placed before tax rates were frozen (left on the provisional rate) =='
SELECT e.market_id, count(*) AS lines
FROM commission_payouts.ledger_entries e
JOIN ordering.order_lines l ON l.market_id = e.market_id AND l.id = e.order_line_id
WHERE e.kind = 'commission' AND l.tax_inclusive AND l.tax_rate_bps IS NULL
GROUP BY 1;

ROLLBACK;
