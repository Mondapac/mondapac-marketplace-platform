-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261027181308_commission_payouts_disputes: grants, the guard function and the three
-- tables (their constraints, indexes and triggers go with them). The ledger and the holds stay.
REVOKE ALL ON TABLE "commission_payouts"."outbox" FROM "mondapac_app";
REVOKE ALL ON TABLE "commission_payouts"."dispute_decisions" FROM "mondapac_app";
REVOKE ALL ON TABLE "commission_payouts"."dispute_cases" FROM "mondapac_app";

DROP TABLE "commission_payouts"."outbox";
DROP TABLE "commission_payouts"."dispute_decisions";
DROP TABLE "commission_payouts"."dispute_cases";
DROP FUNCTION "commission_payouts"."dispute_cases_guard_update"();
