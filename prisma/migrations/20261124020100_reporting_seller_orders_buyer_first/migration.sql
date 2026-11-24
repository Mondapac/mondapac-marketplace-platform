-- Dashboards v2, phase 2: new and returning customers. The two flags ordering freezes on a paid
-- seller order (the buyer's first paid order in the Market, and the buyer's first paid order with
-- this seller), as ordering's reporting facade gives them. Attributes of the fact, not rollup keys:
-- no rollup changes. Nullable without a default, so the ADD COLUMN is a catalog change only (no
-- rewrite); null is unknown (unpaid, paid before ordering recorded the flags, or recorded here
-- before these columns, until the backfill's resumable `buyer-first` pass). No customer or account
-- id is ever stored in reporting.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "reporting"."seller_orders" ADD COLUMN     "buyer_first_order" BOOLEAN,
ADD COLUMN     "buyer_first_with_seller" BOOLEAN;

-- Both or neither, only on a paid fact, and a first order is always the first with its seller.
-- NOT VALID, then VALIDATE: the scan of the existing rows (all null) holds no exclusive lock.
ALTER TABLE "reporting"."seller_orders"
  ADD CONSTRAINT "seller_orders_buyer_first_check" CHECK (
    ("buyer_first_order" IS NULL AND "buyer_first_with_seller" IS NULL)
    OR ("buyer_first_order" IS NOT NULL
      AND "buyer_first_with_seller" IS NOT NULL
      AND "paid_at" IS NOT NULL
      AND (NOT "buyer_first_order" OR "buyer_first_with_seller"))
  ) NOT VALID;
ALTER TABLE "reporting"."seller_orders" VALIDATE CONSTRAINT "seller_orders_buyer_first_check";

-- The backfill's fifth kind: the pass that fills the two columns on rows recorded before them.
ALTER TABLE "reporting"."backfill_progress" DROP CONSTRAINT "backfill_progress_kind_check";
ALTER TABLE "reporting"."backfill_progress"
  ADD CONSTRAINT "backfill_progress_kind_check" CHECK ("kind" IN ('seller-orders', 'refunds', 'ledger', 'delivery', 'buyer-first'));

-- The application role writes the two columns again with the fact (measures of the fact, not its
-- keys); SELECT and INSERT are already table-wide.
GRANT UPDATE ("buyer_first_order", "buyer_first_with_seller") ON TABLE "reporting"."seller_orders" TO "mondapac_app";
