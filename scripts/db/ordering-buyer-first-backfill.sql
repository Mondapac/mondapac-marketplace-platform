-- Ops script (dashboards v2, phase 2): the buyer-first backfill of migration
-- 20261124020000_ordering_buyer_first_orders, the same three statements, to run ONCE AFTER THE
-- DEPLOY of that release (release step, docs/design/data/ordering.md 3.16). Orders paid by the
-- previous release between the migration and the deploy have no claim and keep null flags
-- (unknown) until this runs; running it fills them from the buyer's earliest paid order.
--
-- Idempotent: a claim already there is kept (ON CONFLICT DO NOTHING) and only null flags are
-- written, so no known flag is ever rewritten. Safe to run again. It reads and writes the ordering
-- schema only. Run it as the migration role (owner of the database), once per Region Stack (it
-- covers every hosted Market):
--   psql "$MIGRATION_DATABASE_URL" -f scripts/db/ordering-buyer-first-backfill.sql
-- Above 200,000 seller orders, run it off-peak; each statement holds row locks on the seller
-- orders it writes until COMMIT.
-- If it filled flags after reporting's buyer-first backfill pass finished, delete that pass's
-- reporting.backfill_progress row (kind 'buyer-first') per Market so reporting reads them again
-- (docs/modules/reporting/notes.md).

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '300s';
SET LOCAL lock_timeout = '5s';

\echo '== buyer-first claims and flags =='
INSERT INTO "ordering"."buyer_first_orders" ("market_id", "tenant_id", "account_id", "order_id", "first_order_at")
SELECT DISTINCT ON (o."market_id", o."tenant_id", o."account_id")
       o."market_id", o."tenant_id", o."account_id", o."id", o."confirmed_at"
  FROM "ordering"."orders" AS o
 WHERE o."status" = 'confirmed'
 ORDER BY o."market_id", o."tenant_id", o."account_id", o."confirmed_at", o."id"
    ON CONFLICT DO NOTHING;

INSERT INTO "ordering"."buyer_first_seller_orders" ("market_id", "tenant_id", "account_id", "seller_id", "seller_order_id", "order_id", "first_order_at")
SELECT DISTINCT ON (o."market_id", o."tenant_id", o."account_id", s."seller_id")
       o."market_id", o."tenant_id", o."account_id", s."seller_id", s."id", o."id", o."confirmed_at"
  FROM "ordering"."orders" AS o
  JOIN "ordering"."seller_orders" AS s
    ON s."market_id" = o."market_id" AND s."order_id" = o."id"
 WHERE o."status" = 'confirmed'
 ORDER BY o."market_id", o."tenant_id", o."account_id", s."seller_id", o."confirmed_at", o."id"
    ON CONFLICT DO NOTHING;

-- The flags of every paid seller order, from the claims just written. Only null flags are set.
UPDATE "ordering"."seller_orders" AS s
   SET "buyer_first_order" = (f."order_id" = s."order_id"),
       "buyer_first_with_seller" = (fs."seller_order_id" = s."id")
  FROM "ordering"."orders" AS o,
       "ordering"."buyer_first_orders" AS f,
       "ordering"."buyer_first_seller_orders" AS fs
 WHERE o."market_id" = s."market_id"
   AND o."id" = s."order_id"
   AND o."status" = 'confirmed'
   AND s."paid_at" IS NOT NULL
   AND s."buyer_first_order" IS NULL
   AND f."market_id" = o."market_id"
   AND f."tenant_id" = o."tenant_id"
   AND f."account_id" = o."account_id"
   AND fs."market_id" = o."market_id"
   AND fs."tenant_id" = o."tenant_id"
   AND fs."account_id" = o."account_id"
   AND fs."seller_id" = s."seller_id";

\echo '== paid seller orders still without flags (expected 0) =='
SELECT count(*) AS unknown_flags
  FROM "ordering"."seller_orders"
 WHERE "paid_at" IS NOT NULL AND "buyer_first_order" IS NULL;

COMMIT;
