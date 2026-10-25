-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Phase 6 package 5e: signed fleet webhooks, status polling and the tracking link.
-- The booking keeps the fleet's tracking link (https only), the instant the fleet reported a
-- proof of delivery (never the proof itself) and the instant the status poll last asked the fleet.
ALTER TABLE "shipping"."carrier_bookings"
  ADD COLUMN "tracking_url" TEXT,
  ADD COLUMN "pod_recorded_at" TIMESTAMPTZ(6),
  ADD COLUMN "polled_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "carrier_bookings_tracking_url_check" CHECK ("tracking_url" IS NULL OR ("tracking_url" ~ '^https://[^\s]+$' AND char_length("tracking_url") <= 500));

-- The poll reads the open bookings of one fleet, least recently asked first.
CREATE INDEX "carrier_bookings_poll_idx" ON "shipping"."carrier_bookings" ("market_id", "fleet", "polled_at")
  WHERE "progress" IN ('booked', 'picked-up');
