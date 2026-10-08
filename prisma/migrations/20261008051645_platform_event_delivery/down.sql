-- Reverses 20261008051645_platform_event_delivery (docs/design/data/identity.md 8.2): the grant
-- first, then the table with its CHECKs and indexes (the partial claim index included).
REVOKE SELECT, INSERT, UPDATE ("status", "attempts", "next_attempt_at", "error_code", "delivered_at", "dead_at") ON TABLE "platform"."event_delivery" FROM "mondapac_app";
DROP TABLE "platform"."event_delivery";
