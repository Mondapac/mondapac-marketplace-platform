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
- The AI writer's switch and tier are reviewed at high risk (one at a time, with the reviewer's
  step-up, never bulk-approved), and a revert never switches the writer back on: it answers
  `not-permitted` (403 `system-requests.revert-not-permitted`) and the "off" stands until an admin
  with `settings.ai.manage` switches it on (ADR-0019 R8).
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
- Keys `settings.offer-review.view` and `.manage`, not protected.
- Nothing reads them yet: catalog's referral policy (next slice) reads them through the facade.
