-- Reverses 20261102000000_reviews_outbox: drops reviews' outbox. Events not
-- yet relayed are lost, so this is for a database where no notice depends on them.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "reviews"."outbox" FROM "mondapac_app";
DROP TABLE "reviews"."outbox";
