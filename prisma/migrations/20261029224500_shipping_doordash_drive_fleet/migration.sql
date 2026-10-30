-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- DoorDash Drive joins the fleets (mondapac_drive, uber_direct, zoom2u, auspost, fake_test): every
-- CHECK that lists the fleet codes also allows 'doordash_drive'. Constraints only; no data changes.

ALTER TABLE "shipping"."carrier_bookings" DROP CONSTRAINT "carrier_bookings_fleet_check";
ALTER TABLE "shipping"."carrier_bookings"
  ADD CONSTRAINT "carrier_bookings_fleet_check" CHECK ("fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'doordash_drive', 'auspost', 'fake_test'));

ALTER TABLE "shipping"."carrier_events" DROP CONSTRAINT "carrier_events_carrier_check";
ALTER TABLE "shipping"."carrier_events"
  ADD CONSTRAINT "carrier_events_carrier_check" CHECK ("carrier" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'doordash_drive', 'auspost', 'fake_test'));

ALTER TABLE "shipping"."fleet_reliability" DROP CONSTRAINT "fleet_reliability_fleet_check";
ALTER TABLE "shipping"."fleet_reliability"
  ADD CONSTRAINT "fleet_reliability_fleet_check" CHECK ("fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'doordash_drive', 'auspost', 'fake_test'));

ALTER TABLE "shipping"."fleet_booking_attempts" DROP CONSTRAINT "fleet_booking_attempts_fleet_check";
ALTER TABLE "shipping"."fleet_booking_attempts"
  ADD CONSTRAINT "fleet_booking_attempts_fleet_check" CHECK ("fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'doordash_drive', 'auspost', 'fake_test'));

ALTER TABLE "shipping"."delivery_quotes" DROP CONSTRAINT "delivery_quotes_fleet_check";
ALTER TABLE "shipping"."delivery_quotes"
  ADD CONSTRAINT "delivery_quotes_fleet_check" CHECK ("fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'doordash_drive', 'auspost', 'fake_test'));

ALTER TABLE "shipping"."fleet_fees" DROP CONSTRAINT "fleet_fees_fleet_check";
ALTER TABLE "shipping"."fleet_fees"
  ADD CONSTRAINT "fleet_fees_fleet_check" CHECK ("fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'doordash_drive', 'auspost', 'fake_test'));

ALTER TABLE "shipping"."delivery_fallbacks" DROP CONSTRAINT "delivery_fallbacks_fleets_check";
ALTER TABLE "shipping"."delivery_fallbacks"
  ADD CONSTRAINT "delivery_fallbacks_fleets_check" CHECK ("charged_fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'doordash_drive', 'auspost', 'fake_test')
    AND "booked_fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'doordash_drive', 'auspost', 'fake_test')
    AND "charged_fleet" <> "booked_fleet");

ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_delivery_quote_check";
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_delivery_quote_check" CHECK (
    ("delivery_quote_id" IS NULL AND "delivery_quote_fleet" IS NULL AND "delivery_quote_amount" IS NULL
      AND "delivery_margin_amount" IS NULL AND "delivery_quoted_at" IS NULL AND "delivery_quote_expires_at" IS NULL)
    OR ("delivery_quote_id" IS NOT NULL AND "delivery_quote_fleet" IS NOT NULL
      AND "delivery_quote_amount" IS NOT NULL AND "delivery_margin_amount" IS NOT NULL
      AND "delivery_quote_fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'doordash_drive', 'auspost', 'fake_test')
      AND "delivery_quote_amount" >= 0 AND "delivery_margin_amount" >= 0
      AND "delivery_quoted_at" IS NOT NULL AND "delivery_quote_expires_at" IS NOT NULL
      AND "shipping_amount" = "delivery_quote_amount" + "delivery_margin_amount")) NOT VALID;
ALTER TABLE "ordering"."seller_orders" VALIDATE CONSTRAINT "seller_orders_delivery_quote_check";
