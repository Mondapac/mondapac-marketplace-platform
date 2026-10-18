-- Reverses 20261018150000_engagement_behaviour_events: the grants first, then the tables. Every
-- recorded event and personalization switch is lost with it. The empty schema "engagement" stays,
-- without its USAGE grant, as the leftover check of docs/design/data/platform.md 10.5 (guard 2)
-- expects.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("enabled", "changed_at"), DELETE ON TABLE "engagement"."personalization_settings" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "engagement"."behaviour_events" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "engagement" FROM "mondapac_app";

DROP TABLE "engagement"."personalization_settings";
DROP TABLE "engagement"."behaviour_events";
