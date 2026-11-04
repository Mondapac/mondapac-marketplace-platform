SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261103180000_catalog_attribute_value_suggestions. The suggestions are lost; nothing
-- else refers to them (an approved suggestion's value stays in its attribute's revision).
DROP TRIGGER "attribute_value_suggestions_no_truncate" ON "catalog"."attribute_value_suggestions";
DROP TRIGGER "attribute_value_suggestions_guard" ON "catalog"."attribute_value_suggestions";
DROP FUNCTION "catalog"."attribute_value_suggestions_guard"();
DROP TABLE "catalog"."attribute_value_suggestions";
