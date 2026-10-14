REVOKE DELETE ON TABLE "inventory"."reservations" FROM "mondapac_app";
DROP INDEX "inventory"."reservations_market_id_status_changed_at_terminal_idx";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "inventory"."rate_counters" FROM "mondapac_app";
DROP TABLE "inventory"."rate_counters";
