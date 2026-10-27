-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261027140000_commission_payouts_terms_holds: grants, triggers, the guard function and
-- the four tables (their constraints and indexes go with them). The ledger and the rate table stay.
REVOKE ALL ON TABLE "commission_payouts"."payout_holds" FROM "mondapac_app";
REVOKE ALL ON TABLE "commission_payouts"."eligibility_anchors" FROM "mondapac_app";
REVOKE ALL ON TABLE "commission_payouts"."payout_terms_overrides" FROM "mondapac_app";
REVOKE ALL ON TABLE "commission_payouts"."inbox" FROM "mondapac_app";

DROP TABLE "commission_payouts"."payout_holds";
DROP FUNCTION "commission_payouts"."payout_holds_guard_update"();
DROP TABLE "commission_payouts"."eligibility_anchors";
DROP TABLE "commission_payouts"."payout_terms_overrides";
DROP TABLE "commission_payouts"."inbox";
