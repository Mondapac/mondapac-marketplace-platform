SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261113110000_catalog_variant_requests. The requests are lost; nothing else refers to
-- them (an approved request's variant stays on its product).
DROP TRIGGER "variant_requests_no_truncate" ON "catalog"."variant_requests";
DROP TRIGGER "variant_requests_guard" ON "catalog"."variant_requests";
DROP FUNCTION "catalog"."variant_requests_guard"();
DROP TABLE "catalog"."variant_requests";
