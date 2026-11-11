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
  protected. The view key is in the Viewer role seed (version 31, as the role-seed contract
  requires for every unprotected `.view` key); the manage key is not a viewer key.
- Safe value when the store cannot be read: `multi-store` (today's behaviour). This package only
  stores and reads the choice; the cart (B2) and ordering (B3) read it through their own ports.
