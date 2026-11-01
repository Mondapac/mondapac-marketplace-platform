-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261101050000_shipping_ready_prep_minutes. A saved preparation time is lost; the
-- domain default applies again.
ALTER TABLE "shipping"."delivery_settings"
  DROP CONSTRAINT "delivery_settings_ready_prep_minutes_check",
  DROP COLUMN "ready_prep_minutes";
