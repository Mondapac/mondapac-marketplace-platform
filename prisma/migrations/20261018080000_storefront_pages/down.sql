-- Reverses 20261017210000_storefront_pages: the grants first, then the tables. Every page,
-- version and redirect is lost with it. The empty schema "storefront" stays, without its USAGE
-- grant, as the leftover check of docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT, DELETE ON TABLE "storefront"."redirects" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("state", "placements", "updated_at", "updated_by", "published_at", "published_by") ON TABLE "storefront"."page_versions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("slug", "title", "seo", "linked_type", "linked_id", "starts_at", "ends_at", "archived_at", "archived_redirect", "updated_at", "updated_by") ON TABLE "storefront"."pages" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "storefront" FROM "mondapac_app";

DROP TABLE "storefront"."redirects";
DROP TABLE "storefront"."page_versions";
DROP TABLE "storefront"."pages";
