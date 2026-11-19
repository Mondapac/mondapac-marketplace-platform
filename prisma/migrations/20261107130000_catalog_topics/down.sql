-- Reverses 20261107130000_catalog_topics. Drops the topics with their names and synonyms; every
-- topic defined since is lost. Run it again to start empty.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP TABLE "catalog"."topic_terms";
DROP TABLE "catalog"."topics";
