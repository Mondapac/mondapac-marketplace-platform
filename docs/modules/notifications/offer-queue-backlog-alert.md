# Offer review queue backlog alert (risk-based Offer approval, slice 8)

Design: `design/catalog/offer-approval/offer-approval-design-fa.html`, section 9 (c). ADR-0051.

## What it does
- Job `notifications.raise-offer-queue-backlog-alert`, every 15 minutes for each hosted Market, runs
  `notifications.raise-offer-queue-backlog-alert` (rule `system`).
- Reads the queue through `CatalogWorkQueueFacade.offerReviewQueue` (rule `system`; the count and the
  submission time of the oldest Offer pending first publication; the same indexed aggregate as the
  dashboard count) and the limits through `SettingsFacade.offerQueueBacklogLimits`.
- Backlog = more Offers than `offer-review-backlog-count`, or the oldest Offer has waited more than
  `offer-review-backlog-hours` **business hours**: Monday to Friday in the Market's time zone
  (`businessHoursBetween`, daylight saving counted by real length). Public holidays are not known and
  count as business days (future item FE-20261125-offer-queue-alert-public-holidays).
- One alert for each crossing: `notifications.offer_queue_backlog_alerts` holds one row per crossing,
  open until the queue is back within both limits; a partial unique index (one open row per Market)
  makes overlapping runs raise it once. Back within both limits closes the row and arms the next alert.
- The alert is one admin in-app notice `admin.offer-queue-backlog` (params `reason` age|size|both, `count`,
  `hours`: no Offer, product or seller), shown to admins who hold `catalog.product.approve` (the people
  who work the queue: the queue admin and the manager), linking to `/review?type=offer`.
- A queue that cannot be read raises nothing and closes nothing; the run fails and the next one retries.

## Not in this slice
- E-mail to the same admins: needs a recipient read in identity (who holds a key, with an active second
  factor) and a mail template; planned as the next PR of this slice.
