SET lock_timeout = '5s';

-- Reverses 20261024213000_storefront_slides: the grants first, then the tables. Every slide, version
-- and placement is lost with it. The schema "storefront" stays (the pages tables use it).
REVOKE SELECT, INSERT, UPDATE ("touched_at") ON TABLE "storefront"."slide_position_locks" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "storefront"."slide_placements" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("approved_by", "approved_at") ON TABLE "storefront"."slide_versions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("internal_name", "state", "starts_at", "ends_at", "pinned", "sponsored", "live_version_id", "draft_version_id", "submitted_version_id", "updated_at", "updated_by", "row_version") ON TABLE "storefront"."slides" FROM "mondapac_app";

-- The version pointers of a slide and the versions' own key reference each other: the pointers go first.
ALTER TABLE "storefront"."slides"
  DROP CONSTRAINT "slides_market_id_id_live_version_id_fkey",
  DROP CONSTRAINT "slides_market_id_id_draft_version_id_fkey",
  DROP CONSTRAINT "slides_market_id_id_submitted_version_id_fkey";

DROP TABLE "storefront"."slide_position_locks";
DROP TABLE "storefront"."slide_placements";
DROP TABLE "storefront"."slide_versions";
DROP TABLE "storefront"."slides";
DROP FUNCTION "storefront"."slide_versions_reject_after_approval"();
