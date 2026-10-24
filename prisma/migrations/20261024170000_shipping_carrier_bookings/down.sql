-- Reverses 20261024170000_shipping_carrier_bookings: the grants first, then the tables. The
-- schemas stay (shipping and ordering hold other tables).
REVOKE SELECT, INSERT, UPDATE ("progress", "carrier_status", "version", "updated_at") ON TABLE "shipping"."carrier_bookings" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "shipping"."carrier_events" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "shipping"."outbox" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "ordering"."inbox" FROM "mondapac_app";

DROP TABLE "ordering"."inbox";
DROP TABLE "shipping"."outbox";
DROP TABLE "shipping"."carrier_events";
DROP TABLE "shipping"."carrier_bookings";
