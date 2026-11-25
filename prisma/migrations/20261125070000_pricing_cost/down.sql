-- Reverses 20261125070000_pricing_cost (docs/design/data/pricing.md 8.2): the grants, the
-- triggers, then the tables, child before parent (CHECKs, indexes and the foreign key go with
-- them). reject_mutation() belongs to 20261008183000 and stays.
REVOKE SELECT, INSERT ON TABLE "pricing"."cost_records" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("retired_at", "retire_cause", "version")
  ON TABLE "pricing"."cost_series" FROM "mondapac_app";

DROP TRIGGER "cost_records_no_truncate" ON "pricing"."cost_records";
DROP TRIGGER "cost_records_no_update_delete" ON "pricing"."cost_records";

DROP TABLE "pricing"."cost_records";
DROP TABLE "pricing"."cost_series";
