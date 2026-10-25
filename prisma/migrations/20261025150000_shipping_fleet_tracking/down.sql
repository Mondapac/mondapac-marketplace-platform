-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025150000_shipping_fleet_tracking. The tracking links, proof-of-delivery instants
-- and poll instants are lost.
DROP INDEX "shipping"."carrier_bookings_poll_idx";
ALTER TABLE "shipping"."carrier_bookings"
  DROP CONSTRAINT "carrier_bookings_tracking_url_check",
  DROP COLUMN "polled_at",
  DROP COLUMN "pod_recorded_at",
  DROP COLUMN "tracking_url";
