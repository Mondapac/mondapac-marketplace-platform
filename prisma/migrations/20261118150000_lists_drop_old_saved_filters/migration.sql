-- Lists: drops the two old saved-filter tables (super list phase 0, after B0-1b).
-- Ship it in a release after the shared-store release has fully rolled out, never in the same
-- deploy (migrate deploy runs before the pods are replaced).
-- `catalog.saved_filters` and `ordering.saved_filters` were copied into `lists.saved_filters` by
-- 20261115160000_lists_saved_filters and have had no reader or writer in the code since the
-- release that moved catalog and ordering onto the shared store. Pods of the release before it can
-- still have written rows to the old tables after that first copy, so this migration first copies
-- what is newer, then drops the tables. Deploy it only after every pod runs the shared-store
-- release.

-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

DO $$
DECLARE
  copied_since timestamptz;
  cutoff timestamptz;
  missed integer;
  catalog_new integer;
  ordering_new integer;
  renamed integer;
BEGIN
  -- The moment the first copy began: a filter created in an old table after it was saved by an old
  -- pod; one created before it was copied then (and may since have been deleted on purpose, so it
  -- must not come back).
  SELECT "started_at" INTO copied_since
    FROM "public"."_prisma_migrations"
   WHERE "migration_name" = '20261115160000_lists_saved_filters';
  IF copied_since IS NULL THEN
    RAISE EXCEPTION 'lists: the first copy (20261115160000_lists_saved_filters) is not in the migration history';
  END IF;
  -- `created_at` comes from the writing pod's clock and a transaction can begin before the copy
  -- and commit after it, so the cut-off keeps a margin; a row copied twice is skipped by its id.
  cutoff := copied_since - interval '10 minutes';

  -- A conflict on the id is a row already copied (skipped). A conflict on a name unique fails the
  -- migration loudly instead of dropping the filter.
  WITH copied AS (
    INSERT INTO "lists"."saved_filters"
      ("id", "market_id", "tenant_id", "owner_account_id", "seller_id", "visibility", "list_key",
       "name", "payload", "position", "created_at", "updated_at")
    SELECT "id", "market_id", "tenant_id", "owner_account_id", "seller_id", "visibility",
           "list_key", "name", "payload", "position", "created_at", "updated_at"
      FROM "catalog"."saved_filters"
     WHERE "created_at" >= cutoff
    ON CONFLICT ("id") DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO catalog_new FROM copied;

  WITH copied AS (
    INSERT INTO "lists"."saved_filters"
      ("id", "market_id", "tenant_id", "owner_account_id", "seller_id", "visibility", "list_key",
       "name", "payload", "position", "created_at", "updated_at")
    SELECT "id", "market_id", "tenant_id", "owner_account_id", NULL, "visibility", "list_key",
           "name", "payload", "position", "created_at", "updated_at"
      FROM "ordering"."saved_filters"
     WHERE "created_at" >= cutoff
    ON CONFLICT ("id") DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO ordering_new FROM copied;

  -- A rename or visibility change an old pod made to a copied row after the copy: the newer one wins.
  WITH changed AS (
    UPDATE "lists"."saved_filters" AS n
       SET "name" = o."name", "visibility" = o."visibility", "updated_at" = o."updated_at"
      FROM "catalog"."saved_filters" AS o
     WHERE n."id" = o."id" AND o."updated_at" > n."updated_at"
    RETURNING 1)
  SELECT count(*) INTO renamed FROM changed;
  WITH changed AS (
    UPDATE "lists"."saved_filters" AS n
       SET "name" = o."name", "visibility" = o."visibility", "updated_at" = o."updated_at"
      FROM "ordering"."saved_filters" AS o
     WHERE n."id" = o."id" AND o."updated_at" > n."updated_at"
    RETURNING 1)
  SELECT renamed + count(*) INTO renamed FROM changed;

  -- Older rows missing from the shared table were deleted there on purpose (or never copied): the
  -- operator sees how many, to compare with the row counts taken before the deploy.
  SELECT (SELECT count(*) FROM "catalog"."saved_filters" o
           WHERE o."created_at" < cutoff
             AND NOT EXISTS (SELECT 1 FROM "lists"."saved_filters" n WHERE n."id" = o."id"))
       + (SELECT count(*) FROM "ordering"."saved_filters" o
           WHERE o."created_at" < cutoff
             AND NOT EXISTS (SELECT 1 FROM "lists"."saved_filters" n WHERE n."id" = o."id"))
    INTO missed;

  RAISE NOTICE 'lists: caught up % catalog and % ordering filter(s) saved by old pods, % changed; % older filter(s) are not in the shared table (deleted since the first copy)',
    catalog_new, ordering_new, renamed, missed;
END
$$;

REVOKE SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "catalog"."saved_filters" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "ordering"."saved_filters" FROM "mondapac_app";
DROP TABLE "catalog"."saved_filters";
DROP TABLE "ordering"."saved_filters";
