SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261112020000_catalog_topic_suggestions. The suggestions are lost; nothing
-- else refers to them (an approved suggestion's topic stays in the list).
DROP TRIGGER "topic_suggestions_no_truncate" ON "catalog"."topic_suggestions";
DROP TRIGGER "topic_suggestions_guard" ON "catalog"."topic_suggestions";
DROP FUNCTION "catalog"."topic_suggestions_guard"();
DROP TABLE "catalog"."topic_suggestions";
