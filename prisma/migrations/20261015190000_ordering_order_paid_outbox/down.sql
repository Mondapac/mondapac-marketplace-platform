-- Reverses 20261015190000_ordering_order_paid_outbox: the grants first, then the tables. The
-- schemas stay (ordering and notifications hold other tables).
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "ordering"."outbox" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "notifications"."inbox" FROM "mondapac_app";

DROP TABLE "ordering"."outbox";
DROP TABLE "notifications"."inbox";
