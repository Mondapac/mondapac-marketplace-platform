-- Reverses 20261023223238_storefront_slides: the grants first, then the tables. Every slide, version
-- and placement is lost with it. The schema "storefront" stays (the pages tables use it).
REVOKE SELECT, INSERT, UPDATE ("touched_at") ON TABLE "storefront"."slide_position_locks" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "storefront"."slide_placements" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("approved_by", "approved_at") ON TABLE "storefront"."slide_versions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("internal_name", "state", "starts_at", "ends_at", "pinned", "sponsored", "live_version_id", "draft_version_id", "submitted_version_id", "updated_at", "updated_by") ON TABLE "storefront"."slides" FROM "mondapac_app";

DROP TABLE "storefront"."slide_position_locks";
DROP TABLE "storefront"."slide_placements";
DROP TABLE "storefront"."slide_versions";
DROP TABLE "storefront"."slides";
