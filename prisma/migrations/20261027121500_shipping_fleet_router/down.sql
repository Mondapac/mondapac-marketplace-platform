-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025140000_shipping_fleet_router. A booking by a fleet other than Mondapac Drive
-- cannot be represented by the old single-carrier columns: the reversal stops if one exists
-- (an operator decides what to do with it first). Selection models, assignments, reliability
-- scores and booking attempts are lost.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "shipping"."carrier_bookings" WHERE "fleet" <> 'mondapac_drive')
    OR EXISTS (SELECT 1 FROM "shipping"."carrier_events" WHERE "carrier" <> 'mondapac_drive') THEN
    RAISE EXCEPTION 'cannot reverse: bookings or events of another fleet than mondapac_drive exist';
  END IF;
END $$;

-- The new attention reasons go back to the one the old rule knows.
UPDATE "ordering"."seller_orders" SET "delivery_attention" = 'no-carrier'
  WHERE "delivery_attention" IN ('carrier-unknown', 'cancel-unknown');
ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_delivery_attention_check";
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_delivery_attention_check" CHECK ("delivery_attention" IS NULL OR "delivery_attention" IN ('no-carrier'));

DROP TABLE "shipping"."fleet_booking_attempts";
DROP TABLE "shipping"."fleet_reliability";
DROP TABLE "shipping"."fleet_selection_assignments";
DROP TABLE "shipping"."fleet_selection_models";

ALTER TABLE "shipping"."carrier_events" DROP CONSTRAINT "carrier_events_carrier_check";
UPDATE "shipping"."carrier_events" SET "carrier" = 'mondapac-drive';
ALTER TABLE "shipping"."carrier_events"
  ADD CONSTRAINT "carrier_events_carrier_check" CHECK ("carrier" IN ('mondapac-drive'));

ALTER TABLE "shipping"."carrier_bookings" DROP CONSTRAINT "carrier_bookings_fleet_check";
ALTER TABLE "shipping"."carrier_bookings" DROP CONSTRAINT "carrier_bookings_carrier_reference_check";
ALTER TABLE "shipping"."carrier_bookings" DROP CONSTRAINT "carrier_bookings_carrier_status_check";
UPDATE "shipping"."carrier_bookings" SET "fleet" = 'mondapac-drive';
ALTER TABLE "shipping"."carrier_bookings" RENAME COLUMN "fleet" TO "carrier";
ALTER INDEX "shipping"."carrier_bookings_market_id_fleet_carrier_reference_key"
  RENAME TO "carrier_bookings_market_id_carrier_carrier_reference_key";
ALTER TABLE "shipping"."carrier_bookings"
  ADD CONSTRAINT "carrier_bookings_carrier_check" CHECK ("carrier" IN ('mondapac-drive')),
  ADD CONSTRAINT "carrier_bookings_carrier_reference_check" CHECK ("carrier_reference" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  ADD CONSTRAINT "carrier_bookings_carrier_status_check" CHECK ("carrier_status" ~ '^[A-Z][A-Z_]{1,39}$');
