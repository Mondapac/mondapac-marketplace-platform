-- Reverses 20261025140000_engagement_block_counts: the grant first, then the table. The counts are
-- aggregate numbers only (no personal data); dropping the table loses the history of block views
-- and clicks, which nothing else depends on yet.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("impressions", "clicks", "updated_at"), DELETE ON TABLE "engagement"."block_counts" FROM "mondapac_app";

DROP TABLE "engagement"."block_counts";
