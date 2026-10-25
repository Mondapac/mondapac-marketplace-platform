-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025150000_shipping_fleet_tracking. The tracking links, proof-of-delivery instants
-- and poll instants are lost.
REVOKE UPDATE ("pod_recorded_at", "polled_at") ON TABLE "shipping"."carrier_bookings" FROM "mondapac_app";
DROP INDEX "shipping"."carrier_bookings_market_id_fleet_polled_at_open_idx";
ALTER TABLE "shipping"."carrier_bookings"
  DROP CONSTRAINT "carrier_bookings_tracking_url_check",
  DROP COLUMN "polled_at",
  DROP COLUMN "pod_recorded_at",
  DROP COLUMN "tracking_url";
