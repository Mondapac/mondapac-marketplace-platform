# Physical data model: `storefront` slide library

**Author:** Mojtaba (database-designer), review round of PR #479, 24 Oct 2026
**Ground truth:** `docs/modules/storefront/storefront.md` (slide library); `docs/design/data/platform.md`
(**platform.md**: 10.2 grants, 3.4 triggers); ADR-0009 (insert-only versions), ADR-0018 (no cross-Market admin).
**Files:** `prisma/schema/storefront.prisma`, `prisma/migrations/20261023223238_storefront_slides/`,
`prisma/migrations/20261024130000_storefront_slide_reorder/` (the saved order of live slides, section 5).

This note covers the slide tables only (`slides`, `slide_versions`, `slide_placements`,
`slide_position_locks`, `slide_saved_orders`). Every table carries `market_id` and `tenant_id`, and every statement the
application sends is scoped to the request's Market.

## 1. Access paths

| Read or write | Statement shape | Index that serves it |
|---|---|---|
| Admin list of slides | `market_id = $1` order by `created_at desc, id desc`, limit 500 | `slides (market_id, created_at desc, id desc)` |
| Slide detail, lock | `market_id = $1 AND id = $2` | unique `(market_id, id)` |
| Version list (no JSON) | `market_id, slide_id` order by `version_no desc`, limit 50, **selects scalar columns only** (no `content`, no `placements`) | unique `(market_id, slide_id, version_no)` |
| One version | `market_id, slide_id, id` | unique `(market_id, slide_id, id)`, also the target of the pointer foreign keys |
| Next version number | max `version_no` of `(market_id, slide_id)` | the same unique index |
| Caps of a position in a window | `market_id, position_key`, window overlap | `slide_placements (market_id, position_key, starts_at, ends_at)` |
| Projection rebuild | delete and insert by `(market_id, slide_id)` | `slide_placements (market_id, slide_id)` |
| Live placements of one position and scope (reorder) | `market_id, position_key, scope, scope_id`, `ends_at > now`, slide `state = 'approved'` | `slide_placements (market_id, position_key, starts_at, ends_at)`; a few rows per list (at most 100 asked) |
| Write the order of one list | update `sort_order` by `(market_id, slide_id, position_key, scope, scope_id)`; delete and insert the saved order by its primary key | `slide_placements (market_id, slide_id)`; `slide_saved_orders` primary key |
| Saved orders of a slide | `market_id, slide_id` | primary key prefix |
| Position lock | `(market_id, position_key)` | primary key |

Version rows are the only place the large JSON lives, and no list reads it: the list and the admin
index show names, numbers and stamps. A detail read loads at most two versions (draft and live) by id.

## 2. CHECKs and the invariant each one guards

| Constraint | Invariant |
|---|---|
| `slides_kind_check`, `slides_state_check` | Closed lists of kinds and stored states (ended is derived from the Clock, never stored) |
| `slides_window_check` on slides, versions, placements | End after start, at most 2160 hours (90 days in absolute time) |
| `slides_live_version_check` | An approved or paused slide has a live version; a draft has none |
| `slide_versions_version_no_check` | `version_no` BETWEEN 1 AND 100 (see 4) |
| `slide_versions_content_check` | Content is an object of at most 8192 bytes; `title` present, a string, 1 to 60 characters; `body` and `ctaLabel` only when present, then strings of at most 160 and 24 characters. Present-key checks, so a JSON `null` or a number is refused, and a missing title is refused (a `NULL` comparison would otherwise pass a CHECK) |
| `slide_versions_placements_check` | An array of 1 to 10 placements, at most 4096 bytes |
| `slide_versions_approved_check` | Approver and time are both set or both empty |
| `slide_placements_scope_check`, autoplay and subcategory checks | A scope has an id exactly when it is not `all`; subcategories only for a category; autoplay only at the two autoplay positions; sort order in range |

The application stores no JSON `null` in `content`: absent optional fields are left out.

## 3. Keys, pointers and triggers

- `slide_versions` is unique on `(market_id, slide_id, id)`. The slide's three pointers
  (`live_version_id`, `draft_version_id`, `submitted_version_id`) are composite foreign keys to
  `slide_versions (market_id, slide_id, id)`, `ON DELETE RESTRICT`, so a pointer can name only a
  version of the same slide in the same Market. The slide row is inserted first, with no pointer;
  the version is inserted next, then the pointer is set by an update.
- `slide_placements` is unique on `(market_id, slide_id, position_key, scope, coalesce(scope_id, nil uuid))`:
  a slide is placed once per position and scope. A plain unique index would treat two `NULL` scope ids
  as different.
- `BEFORE UPDATE` trigger `slide_versions_write_once_approval` raises `23001` when the old row already
  has `approved_at`: an approved version is never changed again, not even its stamp. The function is a
  trigger function, so it gets no grant (platform.md 10.2). The repository stamps with
  `WHERE approved_by IS NULL`, so a repeat approval touches no row and does not fire the trigger.
- `slides.row_version` is incremented by the slide lock (the application sends no raw SQL, so the lock
  is a write). It is separate from `updated_at`, which records the last real change.
- The application role may update only the listed columns of `slides`, the two approval columns of
  `slide_versions` and, since the reorder migration, the `sort_order` column of `slide_placements`
  (column-level `UPDATE`); it deletes only placements. `slide_saved_orders` gets `SELECT, INSERT, DELETE`
  and no update (a saved order is replaced by delete and insert).

## 4. Retention

A slide keeps at most **100 versions** (the CHECK above). Versions are never deleted: they are the
audit trail of what buyers were shown. After 100 saves the editor copies the slide into a new slide
and carries on there. Raising the cap needs a migration (the CHECK is the only place it is enforced in
the database; `MAX_VERSIONS_PER_SLIDE` in the domain is the same number).

The `down.sql` of the migration sets `lock_timeout = '5s'` and drops the three pointer foreign keys
before the tables, then the trigger function.

## 5. Saved order of live slides (reorder migration, 24 Oct 2026)

Reordering the live slides of a position needs no approval, but the version a placement comes from is
write-once and the `slide_placements` rows are deleted by a pause and rebuilt by an approval or a
resume. So the order is kept in two places: `slide_placements.sort_order` (what the buyer read sorts
by) and `slide_saved_orders`, one row per `(market_id, slide_id, position_key, scope, scope_key)` with
`sort_order`, `saved_at` and `saved_by`. `scope_key` is `''` for the scope `all`, else the scope id as
lower-case text (a `NOT NULL` column in the primary key; a nullable `scope_id` could not be part of
it). CHECKs: the Market and tenant formats, the position key format, `scope`/`scope_key` agree (empty
exactly for `all`, a uuid otherwise), `sort_order BETWEEN 0 AND 1000`. The foreign key
`(market_id, slide_id)` to `slides` is `RESTRICT`, so a saved order is always of a slide of the same
Market.

A projection (approve, resume) reads the saved orders of the slide, writes each new placement with the
saved `sort_order` if there is one (else the version's), and deletes the saved orders of placements the
new version no longer has. Pausing keeps them. The rows are written only under the slide row lock and
the position row lock (see the module note), so there is no write skew between a reorder and a
projection. `down.sql` revokes the two grants and drops the table; the sort orders already written
to `slide_placements` stay.
