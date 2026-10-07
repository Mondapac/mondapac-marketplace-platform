-- Reverses 20261007220000_platform_btree_gist. It fails while a table still uses the extension's
-- operator class, which is right: the migration that created that table is reversed first.
DROP EXTENSION "btree_gist";
DROP SCHEMA "extensions";
