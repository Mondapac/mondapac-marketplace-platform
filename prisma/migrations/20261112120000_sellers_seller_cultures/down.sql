-- Reverses 20261112120000_sellers_seller_cultures. Drops every seller culture membership; the
-- memberships made since are lost. Run it again to start empty.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP TABLE "sellers"."seller_cultures";
