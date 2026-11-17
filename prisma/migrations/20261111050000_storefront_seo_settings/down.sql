-- Reverses 20261111050000_storefront_seo_settings: the grants first, then the tables. Events not yet
-- relayed are lost, so this is for a database where no consumer depends on them.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "storefront"."outbox" FROM "mondapac_app";
DROP TABLE "storefront"."outbox";

REVOKE SELECT, INSERT ON TABLE "storefront"."seo_settings" FROM "mondapac_app";

DROP TABLE "storefront"."seo_settings";
