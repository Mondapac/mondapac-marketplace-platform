-- AI Gateway G4a (Hassan, PR 1362 finding 1): the reason an admin gives for a setting change
-- (always required for an emergency stop) is kept on the history row, whether or not the Market
-- reviews the area. The audit row cannot hold free text (ADR-0009). Nullable: earlier rows and
-- changes without a note have none. Adding a nullable column without a default rewrites nothing.
SET lock_timeout = '5s';
ALTER TABLE "settings"."market_setting_history" ADD COLUMN "note" TEXT;

ALTER TABLE "settings"."market_setting_history"
  ADD CONSTRAINT "market_setting_history_note_check"
  CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 500 AND "note" = btrim("note")));
