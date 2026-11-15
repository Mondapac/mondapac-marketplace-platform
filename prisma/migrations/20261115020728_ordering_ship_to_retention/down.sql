-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261115020728_ordering_ship_to_retention: the setting goes (every Market is off
-- again) and the app role can no longer clear a sealed ship-to. Addresses already cleared stay
-- cleared: the deletion is irreversible by design.
REVOKE UPDATE ("ship_to_ciphertext") ON TABLE "ordering"."orders" FROM "mondapac_app";
DROP TABLE "ordering"."ship_to_retention_settings";
