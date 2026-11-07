SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Hand-written (database-designer): attributes package A3. The new data type `measure` (number
-- with a unit) is allowed. A measure's unit settings live in the revision's existing `bounds`
-- object (key `measure`), so no column is added. The CHECK is replaced in one statement, which
-- validates the existing rows (none is a measure) under a short ACCESS EXCLUSIVE lock on a small
-- table.
ALTER TABLE "catalog"."attribute_definitions"
  DROP CONSTRAINT "attribute_definitions_data_type_check",
  ADD CONSTRAINT "attribute_definitions_data_type_check" CHECK ("data_type" IN
    ('text', 'long-text', 'integer', 'decimal', 'boolean', 'select', 'multi-select', 'date', 'measure'));
