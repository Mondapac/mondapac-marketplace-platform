-- Customers phase 1, package B3: every directory row gets a stats row (all zero for a customer who
-- never ordered), so the list sorts by order count and spent without a null from the join. The
-- sync and the reconcile write the row from now on. Existing rows are never changed.
SET lock_timeout = '5s';

INSERT INTO "customers"."customer_stats"
  ("market_id", "tenant_id", "account_id", "order_count", "spent_minor", "refund_count", "refunded_minor", "computed_at")
SELECT d."market_id", d."tenant_id", d."account_id", 0, 0, 0, 0, now()
  FROM "customers"."customer_directory" d
 WHERE NOT EXISTS (SELECT 1 FROM "customers"."customer_stats" s
                    WHERE s."market_id" = d."market_id" AND s."account_id" = d."account_id");
