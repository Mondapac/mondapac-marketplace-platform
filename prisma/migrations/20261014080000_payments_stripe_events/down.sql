-- Reverses 20261014080000_payments_stripe_events: the grants first, then the table. Its index and
-- CHECKs go with it. The empty schema "payments" stays, without its USAGE grant, as the leftover
-- check of docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ("attempts", "next_attempt_at", "processed_at", "outcome") ON TABLE "payments"."stripe_events" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "payments" FROM "mondapac_app";

DROP TABLE "payments"."stripe_events";
