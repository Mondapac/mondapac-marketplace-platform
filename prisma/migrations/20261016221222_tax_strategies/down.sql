-- Reverses 20261016221222_tax_strategies: the grants first, then the table. Every strategy is lost
-- with it. The empty schema "tax" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ("name", "kind", "config", "active", "updated_at", "updated_by"), DELETE ON TABLE "tax"."tax_strategies" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "tax" FROM "mondapac_app";

DROP TABLE "tax"."tax_strategies";
