-- Never run this against production after launch: it drops every blog post, version, category,
-- tag, redirect, quota row and the blog's outbox and inbox, and the seller blog switch. Reverses
-- 20261028050514_blog_core: the grants first, then the triggers and functions, then the tables
-- (children first, which drops their indexes and foreign keys), then the columns of the sellers'
-- admin settings. The empty schema "blog" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "blog"."inbox" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "blog"."outbox" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("used", "updated_at") ON TABLE "blog"."seller_quotas" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE, UPDATE ("name") ON TABLE "blog"."tags" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE, UPDATE ("name") ON TABLE "blog"."category_names" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE, UPDATE ("position", "updated_at", "updated_by") ON TABLE "blog"."categories" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "blog"."redirects" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "blog"."post_tags" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "blog"."post_links" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE, UPDATE ("starts_at", "ends_at", "time_zone", "attendance", "venue_name", "address", "registration_url", "event_status", "status_message") ON TABLE "blog"."post_events" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("state", "title", "excerpt", "body", "cover_image_id", "cover_alt", "seo_title", "seo_description", "author_display", "category_id", "updated_at", "submitted_at", "submitted_by", "decided_at", "decided_by", "decision", "decision_note", "self_approved", "published_at", "published_by") ON TABLE "blog"."post_versions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("slug", "status", "live_version_id", "draft_version_id", "scheduled_at", "scheduled_by", "published_at", "unpublished_at", "paused_reason", "featured", "quota_period", "updated_at", "updated_by", "row_version") ON TABLE "blog"."posts" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "blog" FROM "mondapac_app";

-- The version pointers of a post and the versions' own key reference each other: the pointers go first.
ALTER TABLE "blog"."posts"
  DROP CONSTRAINT "posts_market_id_id_live_version_id_fkey",
  DROP CONSTRAINT "posts_market_id_id_draft_version_id_fkey";

DROP TABLE "blog"."inbox";
DROP TABLE "blog"."outbox";
DROP TABLE "blog"."seller_quotas";
DROP TABLE "blog"."redirects";
DROP TABLE "blog"."post_tags";
DROP TABLE "blog"."post_links";
DROP TABLE "blog"."post_events";
DROP TABLE "blog"."post_versions";
DROP TABLE "blog"."posts";
DROP TABLE "blog"."tags";
DROP TABLE "blog"."category_names";
DROP TABLE "blog"."categories";
DROP FUNCTION "blog"."redirects_guard_slug"();
DROP FUNCTION "blog"."posts_guard_slug"();
DROP FUNCTION "blog"."post_events_guard_update"();
DROP FUNCTION "blog"."version_child_requires_draft"();
DROP FUNCTION "blog"."post_versions_guard_update"();

ALTER TABLE "sellers"."seller_admin_settings"
  DROP CONSTRAINT "seller_admin_settings_blog_enabled_changed_check",
  DROP COLUMN "blog_enabled_by",
  DROP COLUMN "blog_enabled_at",
  DROP COLUMN "blog_enabled";
