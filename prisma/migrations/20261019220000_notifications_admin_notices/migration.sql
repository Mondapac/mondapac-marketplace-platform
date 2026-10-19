-- In-app notifications package 3: admin review notices. An admin notice is addressed to the
-- Market's admins (`audience = 'admin'`, no seller); the permission its kind needs is checked when
-- it is read, as for seller notices. The list and count use the existing
-- (market_id, seller_id, id DESC) index with `seller_id IS NULL`. Retention 90 days, at most 200
-- admin notices per Market (the purge job and the writer delete the rest).

-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

ALTER TABLE "notifications"."in_app_notices"
  DROP CONSTRAINT "in_app_notices_audience_check",
  ADD CONSTRAINT "in_app_notices_audience_check" CHECK ("audience" IN ('seller', 'admin'));
