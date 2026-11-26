# settings: admin-editable Market settings, package 1 (the store and List paging)

Speed mode (CLAUDE.md): no G1/G2 or design document. This note records the owner's decisions
(project thread, 1 Nov 2026) and what the code does. The decision is ADR-0042 (it builds the
store of ADR-0026).

## Owner decisions (binding)

- S1 One shared store for platform-level, admin-editable Market settings, in the `settings`
  schema, owned by this module (a permission key must start with a module name, so the store needs
  a module). A new setting of this kind is a definition in `domain/definitions.ts`, not a new table.
- S2 The settings other modules already keep (`reviews`, `wallet`, `promotions`, ...) are not
  changed. Moving one is its own owner-approved PR, one setting at a time (ADR-0042 decision 6).
- S3 The first setting is `list-paging`: how every list in both panels pages. `pages` (page numbers
  with the total) is the default, `prev-next` (Previous and Next) the other value. If the store
  cannot be read, readers get `prev-next` (the safe value). The page-number mode stops at row
  10,000 and falls back to Previous and Next (design, Lists and Orders).

## What the code does

- `settings.market_settings` holds the current value of a setting per Market (value, version,
  stamps; no delete). `settings.market_setting_history` is insert-only: one row per change (who,
  when, before, after). A trigger refuses UPDATE, DELETE and TRUNCATE on the history and DELETE and
  TRUNCATE on the settings.
- Routes: `GET /settings/admin/market-settings` and `PUT /settings/admin/market-settings` (admin;
  keys `settings.list-paging.view` and `.manage`, not protected), `GET /settings/admin/list-paging`
  and `GET /settings/seller/list-paging` (any signed-in panel user).
- A change checks the version the admin saw (a stale edit is 409 `settings.conflict`), is refused in
  an acting-as session, writes the value and the history row in one unit, and is audited as
  `settings.market-setting.changed` (value and version only). Asking for the value in force changes
  nothing.
- Not here yet: the Settings › Lists admin page, the panels reading the mode, the registry-driven
  settings search, the `platform.market-setting.changed.v1` outbox event and the senior-admin mail
  of ADR-0026 decision 10 (List paging is not a protected setting).

## Cart mode (package B1)

- Second setting in the same store: code `cart-mode`, values `multi-store` (default) and
  `single-store`, per Market. No migration: the tables already take any code and value.
- Routes: `GET /settings/admin/cart-mode` and `PUT /settings/admin/cart-mode` (body `value` and
  `expectedVersion`; the route fixes the code). Keys `settings.cart-mode.view` and `.manage`, not
  protected. The view key is in the Viewer role seed (version 32, as the role-seed contract
  requires for every unprotected `.view` key); the manage key is not a viewer key.
- Safe value when the store cannot be read: `multi-store` (today's behaviour). This package only
  stores and reads the choice; the cart (B2) and ordering (B3) read it through their own ports.

## Review in System requests (Admin Inbox)

- Every change of a setting here opens a review in Admin Inbox › System requests when the Market
  reviews area `marketplace` (off by default): the change still goes live at once, the body takes
  an optional `note` (1 to 500 characters, required only while the area is reviewed, else a 400 on
  `note` and nothing is saved), and the answer adds `request: {id, number}` (null when nothing was
  opened). Every setting view carries `review: {reviewed, risk}`.
- A rejected or withdrawn request restores the value before through `SettingsReverter` (kind
  `settings.market-setting`), only while the setting still holds the value after; it is a new
  version with its history and audit row and opens no new review.
- The AI writer's switch is reviewed at high risk (one at a time, with the reviewer's step-up,
  never bulk-approved), and a revert never switches the writer back on: it answers
  `not-permitted` (403 `system-requests.revert-not-permitted`) and the "off" stands until an admin
  with `settings.ai.manage` switches it on (ADR-0019 R8).
- The writer's model tier setting (`ai-description-writer-tier`) went in AI Gateway G4d1: the
  writer's models are the Market's `ai-models-write` list. Its stored rows stay (ADR-0026
  decision 4), no view, change or read sees them, and a review of an old change reverts as `gone`.
- By design a revert needs the area's review key, not the setting's own manage key (maker-checker:
  the reviewer undoes, they do not set a new value). It compares values, not versions: a change
  and its undo made while the area was off leave no request, and a later revert restores over them.
- The admin panel sends no `note` yet; keep area `marketplace` off in a Market until the panel's
  save dialog asks for one (frontend package), or every save there answers 400 on `note`.

## Offer review policy (risk-based Offer approval, ADR-0051)

- Six settings on one page, Settings › Catalogue › Offer review: `offer-review-mode`
  (`risk-based` default, `all` safe, `off`), `offer-review-probation-offers` (10, 0 to 100, safe 100),
  `offer-review-reference-sellers` (3, 2 to 20, safe 20), `offer-review-price-band` (50 %, 5 to 200,
  safe 5), `offer-review-sampling` (5 %, 0 to 100, safe 100) and `offer-review-certificate-badges`
  (`review` default and safe, `automatic`).
- The four numbers are the store's first whole-number settings: stored as decimal text, checked
  against bounds, audited by `settings.market-setting.number-changed` with integer values.
- `GET` and `PUT settings/admin/offer-review`; the write takes `changes: [{code, value,
expectedVersion}]`, each code once, all or nothing (every version checked before any write). Each
  change keeps its own history row, audit row and review request.
- Keys `settings.offer-review.view` (Viewer role, seed 37) and `.manage` (protected, second
  factor). Reviewed at high risk where area `marketplace` is reviewed. A stored value outside the
  definition is read as the safe value and logged (every setting, not only these).
- Nothing reads them yet: catalog's referral policy (next slice) reads them through the facade.

## Offer review queue alert limits (risk-based Offer approval, slice 8)

- Two more whole-number settings on the same page (Settings › Catalogue › Offer review, section
  "Queue alert"): `offer-review-backlog-count` (50, 1 to 10000) and `offer-review-backlog-hours`
  (24, 1 to 720, business hours). Both are strict ("more than"). Safe value on an unreadable store:
  the launch value (the alert job skips a run it cannot read the queue for, so a safe value never
  raises an alert of its own).
- `SettingsFacade.offerQueueBacklogLimits(context)` hands both to notifications' worker job; rule
  `system` (use case `settings.read-offer-queue-backlog-limits`).

## Monthly revenue target (dashboards v2, phase 2)

- Eleventh setting in the same store, the first whose value is an amount: code
  `monthly-revenue-target`, value `none` (default and safe value) or `<ISO 4217>:<minor units>`
  (for example `AUD:24000000`, at most 15 digits, above zero). A definition may now carry a
  `pattern` besides its list of values: `acceptedValue` takes a value that matches it, so the
  change, the revert and the stored-value check of a read accept it.
  No migration: the value column takes 1 to 64 characters.
- Routes: `GET` and `PUT settings/admin/monthly-revenue-target`; the body is
  `{target: {amount, currency} | null, expectedVersion, note?}` and the currency must be the
  Market's (`validation.failed` on `target.currency` otherwise). Keys
  `settings.monthly-revenue-target.view` (in the Viewer role, seed version 38) and `.manage`, both
  unprotected.
- Audited as `settings.monthly-revenue-target.changed` with the target before and after as money
  (the enum action `settings.market-setting.changed` cannot hold an amount); both fields are on the
  audit money allow-list.
- Read by reporting through `SettingsFacade.monthlyRevenueTarget` (use case
  `settings.read-monthly-revenue-target`, the view key). An unreadable store is
  `access.unavailable`, never "no target".
- Review (Hassan L2, accepted): where the Market reviews area `marketplace`, the System requests row
  of a change shows the target before and after to every reviewer of that area, also one without
  `settings.monthly-revenue-target.view`; the other settings are reviewed the same way.

## Offer review emergency stop (R0, risk-based Offer approval slice 2b)

`offer-review-emergency-stop` (`off`/`on`, default and safe value `off`) is a Market setting with
its own protected permission `settings.offer-review.emergency-stop` (Platform Administrator, or a
senior custom role; admin second factor). It is not part of the Offer review page's list, so the
`settings.offer-review.manage` save can never switch it. `PUT settings/admin/offer-review/emergency-stop`
takes `value`, `expectedVersion` and a `note` that is always required (1 to 500 characters); the
change is live at once, audited as `settings.market-setting.changed` and reviewed at high risk
afterwards where the area is reviewed. Nothing switches it off by itself, and a rejected or
withdrawn review never switches it off either: that revert answers `not-permitted`, so only a
holder of the stop's own key turns it off (a rejected "off" is restored to on).
So a review request that switched the stop on cannot be rejected or withdrawn: the Reject answers
`403 system-requests.revert-not-permitted` and the request stays open until it is approved or
superseded; the admin turns the stop off on its own page instead (Hassan L1; hiding Reject
beforehand is FE-20261125-offer-review-stop-reject-hint).
Both Offer review saves need a fresh two-step code of the admin, spent in the change's unit
(settings step-up actions, admin audience, locked): `settings.offer-review-emergency-stop.change`
for the stop and `settings.offer-review.change` for the Offer review page; without one the route
answers `403 second-factor.required` with `details.actionKey` and the panel asks for the code.
`GET settings/admin/offer-review/emergency-stop` (rule own-resources, admins only) answers `on`,
the version, when it was last switched and the display name of who switched it (identity
`changeActors`); the admin shell shows a critical banner on every page while it is on.
`SettingsFacade.offerReviewPolicy` carries `emergencyStop`; the catalog policy adds the
`emergency-stop` reason to every new Offer while it is on, whatever the mode. Deferred:
FE-20261125-offer-review-stop-reminder, -stop-scopes, -stop-recent-sampling.

## Buyer chat caps (AI Gateway G4d2): a data move into this store

- `ai-cap-buyer-chat-day` and `ai-cap-buyer-chat-month` (US micro-dollars or `none`, defaults
  10000000 and 200000000) hold the buyer assistant's spend caps, which lived in
  `assistant.settings` before. The platform migration `20261126030000_ai_gateway_buyer_chat_caps`
  wrote rows into `settings.market_settings` and `settings.market_setting_history` (version 1, no
  previous value, no note, the admin and time of the Market's latest assistant version) for each
  Market whose assistant caps differed from the defaults (cents x 10000). This is the one time
  rows of this store were written by a migration, not by a use case; a Market on the defaults got
  no row.
- Rollback: the migration's `down.sql` (one transaction) first carries a gateway cap stricter
  than the assistant's latest value back as a new assistant settings version (floor of
  micro-dollars / 10000 cents, at least the column's minimum of 100 cents), then deletes every row
  and history row of the two codes, so a looser cap saved on the AI Gateway page after the
  migration is lost and the assistant's value is in force again. It briefly disables the
  insert-only delete triggers for that and switches them on again.
- A revert of a rejected review can leave the day cap above the month cap (the page refuses it,
  a revert is never blocked); the gateway enforces both lines independently on every call.

## AI capability switches, history and panel revert (AI Gateway G4d3)

Three more choice settings, `ai-capability-assistant-buyer-chat`,
`ai-capability-catalog-description-writer-seller` and
`ai-capability-catalog-description-writer-admin` (`off|on`, default `on`, safe value `off`), are
read by the gateway through `SettingsAiGatewayControls` as `capabilities` and changed with `PUT
settings/admin/ai-gateway/capabilities` (switching on spends `settings.ai-capability.resume`).
`ChangeAiSetting` (the writer's module switch) spends the same action for off to on, through the
optional step-up rule `changeSetting` now takes. The repository gained `history(market, code,
limit)` and `historyVersion(market, code, version)`, both on the history table's primary key, for
`GET .../ai-gateway/history`, `GET .../ai-models/history` and the two `POST .../revert` routes
(`application/ai-settings-history.ts`): a revert is a forward change through `changeSettings` and
always spends `settings.ai-settings.revert`. The review reverter still never allows more AI. Full
note: docs/design/domain/platform-ai.md (Built in G4d3).
