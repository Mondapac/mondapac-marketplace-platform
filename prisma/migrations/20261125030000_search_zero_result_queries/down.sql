-- Reverses 20261125030000_search_zero_result_queries. The noted texts are lost; the snapshot of a day
-- not yet written then keeps no query for it, which is acceptable for derived dashboard data.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, DELETE ON TABLE "search"."zero_result_queries" FROM "mondapac_app";
DROP TABLE "search"."zero_result_queries";
