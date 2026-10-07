-- The btree_gist extension in its own schema (docs/design/data/sellers.md 9.2, ADR-0023
-- decision 5, Ali's O1 ruling). Exclusion constraints on `=` of market and seller ids need it
-- (sellers tax registration periods, and other modules' V2 records later).
--
-- No grant on purpose: `mondapac_app` has no USAGE on "extensions", yet inserts and updates
-- through the index and is refused on overlap, since index maintenance needs no USAGE or
-- EXECUTE. "extensions" is on nobody's search_path. btree_gist is a trusted extension, so the
-- migration role (database owner) creates it without a superuser.
CREATE SCHEMA "extensions";
CREATE EXTENSION "btree_gist" SCHEMA "extensions";
