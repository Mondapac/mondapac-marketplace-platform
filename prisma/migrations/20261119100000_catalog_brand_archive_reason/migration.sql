-- Catalog brand: an admin's optional reason when it archives a brand (a seller proposal turned down
-- or a live brand retired), kept on the brand row for the proposing seller's notice. Audit rows and
-- events carry no text (ADR-0009 decision 6), so the text lives here; the audit row records only
-- `reasonGiven`. Nullable, no default, no backfill: every existing row reads as "no reason".

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "catalog"."brands" ADD COLUMN     "archive_reason" TEXT;

-- Hand-written: CHECK. Only an archived brand has a reason; it is stored trimmed, 1 to 500
-- characters, with no control character (the application refuses those before it writes).
ALTER TABLE "catalog"."brands"
  ADD CONSTRAINT "brands_archive_reason_check" CHECK (
    "archive_reason" IS NULL OR (
      "status" = 'archived'
      AND "archive_reason" = btrim("archive_reason")
      AND char_length("archive_reason") BETWEEN 1 AND 500
      AND "archive_reason" !~ '[[:cntrl:]]'));

-- Grants (database-designer): the API sets the reason with the archive (an UPDATE of the row).
-- SELECT and INSERT are table-level grants and already cover the new column.
GRANT UPDATE ("archive_reason") ON TABLE "catalog"."brands" TO "mondapac_app";
