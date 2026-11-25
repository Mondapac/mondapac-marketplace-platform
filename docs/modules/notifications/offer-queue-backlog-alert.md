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

## E-mail (slice 8b)
- After the unit that opened the alert row commits, the same crossing is mailed. Only the run that
  opened the row sends, so each crossing is mailed **at most once**; the panel notice stands whatever
  the mail does, and a mail failure never changes the alert's outcome.
- Recipients: `IdentityFacade.offerReviewAlertRecipients` (identity use case
  `identity.offer-review-alert-recipients`, rule `system`). identity applies the reviewer rule of
  identity design 8.7 (`AccountAccessReviewers.holdersOf`) to the fixed key `catalog.product.approve`:
  admin accounts of the Market that are active, have a verified e-mail and an **active second factor**,
  and hold the key among their effective keys (the same resolver as the gate). No caller input picks the
  key or the population. At most 50, by account id (more: an error log with the count). A failed read
  is `access.unavailable`; the mail is then skipped with an error log. identity does not import catalog,
  so the key is written in identity and `test/contracts/offer-review-alert-key.contract.spec.ts` checks
  it equals `CATALOG_PRODUCT_APPROVE`.
- Template `offer-queue-backlog-alert` (plain text, English, Market locale fallback): the reason, the
  Market id, the queue size and the oldest wait in whole business hours. No seller, Offer, product or
  person data, no link (the text names the admin page). One mail per recipient, one address each.
- Sends run one after another, each bounded by 5 s, all by 20 s (the job's run limit is 60 s); a send
  that times out counts as failed. Logs carry counts and codes only, never an address.

## Not in this slice
- Retry of a failed backlog mail (FE-20261125-offer-queue-alert-mail-retry).
- A link to the queue in the mail (FE-20261125-offer-queue-alert-mail-link).
- A repeat reminder while the queue stays behind (FE-20261125-offer-queue-alert-repeat-reminder).
