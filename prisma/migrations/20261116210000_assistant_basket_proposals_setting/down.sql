-- Reverses 20261116210000_assistant_basket_proposals_setting: drops the column. A version that had
-- the switch on then reads as off.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "assistant"."settings" DROP COLUMN "basket_proposals";
