-- Reverses 20261115140000_promotions_credits_by_recipient.
SET lock_timeout = '5s';

DROP INDEX "promotions"."credit_issuances_recipient_newest_idx";
