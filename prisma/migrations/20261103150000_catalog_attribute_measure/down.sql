SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261103150000_catalog_attribute_measure. A measure definition cannot be represented
-- by the earlier schema, so the CHECK is restored only when none exists (it fails otherwise:
-- an archived definition keeps its type, and there is no safe type to convert it to).
ALTER TABLE "catalog"."attribute_definitions"
  DROP CONSTRAINT "attribute_definitions_data_type_check",
  ADD CONSTRAINT "attribute_definitions_data_type_check" CHECK ("data_type" IN
    ('text', 'long-text', 'integer', 'decimal', 'boolean', 'select', 'multi-select', 'date'));
