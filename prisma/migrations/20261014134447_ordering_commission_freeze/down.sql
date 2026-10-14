-- Reverses 20261014134447_ordering_commission_freeze: the grant, the index, the checks and the
-- columns go. The frozen rates are lost with them (the ledger rows keep their own copy).
REVOKE UPDATE ("ledger_state") ON TABLE "ordering"."seller_orders" FROM "mondapac_app";

DROP INDEX "ordering"."seller_orders_unrecorded_ledger_idx";
ALTER TABLE "ordering"."seller_orders"
  DROP CONSTRAINT "seller_orders_ledger_state_check",
  DROP COLUMN "ledger_state";
ALTER TABLE "ordering"."order_lines"
  DROP CONSTRAINT "order_lines_commission_rate_bps_check",
  DROP COLUMN "commission_rate_bps";
