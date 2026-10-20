-- Reverses 20261020002100_notifications_cart_reminders: the grant, then the table. The record of
-- reminders taken is lost, so a cart idle at the time may get a stage again.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, DELETE ON TABLE "notifications"."cart_reminders" FROM "mondapac_app";
DROP TABLE "notifications"."cart_reminders";
