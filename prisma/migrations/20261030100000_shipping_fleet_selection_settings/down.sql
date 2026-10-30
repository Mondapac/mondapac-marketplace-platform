-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261030100000_shipping_fleet_selection_settings. Only the page version is lost; the
-- active models and the reliability scores live in their own tables and stay.
DROP TABLE "shipping"."fleet_selection_settings";
