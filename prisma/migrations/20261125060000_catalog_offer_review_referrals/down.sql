-- Reverses 20261125060000_catalog_offer_review_referrals. The recorded decisions are lost; the
-- Offers keep their status, and a re-applied migration starts with an empty table.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

DROP TABLE "catalog"."offer_review_referrals";
