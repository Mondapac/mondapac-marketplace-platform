-- Reverses 20261009030000_catalog_offers (docs/design/data/catalog.md 8.3): the grants first,
-- then the insert-only triggers, then the tables, child before parent. The insert-only triggers
-- do not fire on DROP TABLE. CHECKs, indexes and foreign keys go with their tables.
REVOKE SELECT, INSERT ON TABLE "catalog"."offer_history" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("product_id", "seller_sku", "condition_code", "description", "handling",
  "attestation_recorded_at", "attestation_account_id", "status", "off_sale_type_not_allowed",
  "off_sale_product_retired", "off_sale_product_not_listed", "off_sale_tag_suspended",
  "off_sale_description_claim_text", "listed", "submitted_at", "first_published_at", "deleted_at",
  "version")
  ON TABLE "catalog"."offers" FROM "mondapac_app";
DROP TRIGGER "offer_history_no_truncate" ON "catalog"."offer_history";
DROP TRIGGER "offer_history_no_update_delete" ON "catalog"."offer_history";
DROP TABLE "catalog"."offer_history";
DROP TABLE "catalog"."offers";
