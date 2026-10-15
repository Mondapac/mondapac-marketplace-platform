-- Reverses 20261015170000_notifications_support_contact: the grants first, then the table. The
-- empty schema "notifications" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT ON TABLE "notifications"."support_contacts" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "notifications" FROM "mondapac_app";

DROP TABLE "notifications"."support_contacts";
