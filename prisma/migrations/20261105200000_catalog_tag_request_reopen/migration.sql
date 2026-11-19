-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Categories package C4a (review of #712): a category move, merge or archive makes the request of
-- each affected product's published revision pending again (one request per revision is kept by
-- the partial unique), with a new `created_at` strictly after the stored one. The job's cursor and
-- close match the `created_at` the run read, so a run already under way on the old request never
-- moves the cursor of, or closes, the reopened one. A grant only: no data or lock beyond the
-- catalog entry.
GRANT UPDATE ("created_at") ON TABLE "catalog"."tag_reevaluation_requests" TO "mondapac_app";
