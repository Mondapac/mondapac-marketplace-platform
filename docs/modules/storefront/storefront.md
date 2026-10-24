# Storefront (buyer-site content), backend v1

Speed mode (no G1/G2). Source: the content-management analysis approved by the owner on
17 Oct 2026 (option 2: ordered, admin-editable modules inside fixed, team-set sections; header,
the "Browse products" button, the mobile bottom bar and the footer are locked), plus the owner's
17 Oct 18:15Z rule that the left-rail items and the Browse drawer's categories are dynamic and
go live only after a platform admin approves them.

## Model

- **Templates, slots and modules are code** (`domain/templates.ts`, `domain/modules.ts`), never
  rows. A template lists its slots in order; a `modules` slot names the modules it allows and
  its minimum and maximum; a `fixed` slot is a section the buyer app draws itself (product
  details, a category's product list, the cart).
- **v1 templates** for new pages: `campaign-landing`, `brand-page`, `product-spotlight`,
  `info-page`. System pages have their own template each (`system.home`, ...); checkout, order
  confirmation and account are `locked`.
- **Module catalogue (closed)**: banner, category-circles, sellers-near-you, product-shelf
  (sources: bestsellers, specials, category, seller, tag, manual, linked), info-strip,
  text-block, image-text, faq, brand-header, product-spotlight, nav-link, nav-category. Every
  module checks its settings; texts are plain text (no control or format characters, no HTML),
  rich text is data (heading level 2 or 3, paragraph, list), links are site paths or `https:`
  URLs, images are ready-made image keys with required alt text until catalog media exists.
- **Tables** (`storefront` schema): `pages` (system pages by key, created on first edit; dynamic
  pages by slug, served at `/l/<slug>`; never deleted, archived instead), `page_versions` (one
  `draft`, one `published` per page, older ones `retired`; `placements` JSON per slot), and
  `redirects` (old slugs).
- **Settings wait for publishing**: a page's title, slug, SEO fields, linked entity and live
  window, once changed, are held in its draft (`page_versions.settings`) and put on the page row
  only when a platform admin publishes it, so an editor never changes what buyers see. A new
  slug must be free at that moment; the old one then redirects (if buyers could reach it).
- **Publishing what was reviewed**: publish and approve take the draft's `versionNo` and
  `updatedAt` as the publisher saw them, and answer `storefront.draft-changed` (409) when the
  draft changed since.
- **Size**: one module's stored settings stay within 32 KB and one version's placements within
  256 KB. The public reads are in the `default` per-origin rate-limit class like every
  market-scoped route.
- **Navigation** is the system page `navigation` (slots `rail`, `drawer-popular`,
  `drawer-categories`), with its own use cases and keys.

## Permissions

| Key | Protected | Use |
|---|---|---|
| `storefront.page.read` | no | page list, page detail, catalogue, navigation draft |
| `storefront.page.edit` | no | page settings and draft modules, restore a version |
| `storefront.page.create` | no | create a landing page |
| `storefront.page.publish` | yes | publish a page's draft |
| `storefront.page.archive` | yes | archive a landing page |
| `storefront.navigation.edit` | no | replace the navigation draft, restore a version |
| `storefront.navigation.approve` | yes | approve the navigation draft |
| `storefront.slide.read` | no | slide list, detail, copy package |
| `storefront.slide.edit` | no | create, replace draft, restore, submit for approval, archive, reorder the live slides of a position (no approval) |
| `storefront.slide.pause` | no | pause an approved slide (stops at once, no approval) |
| `storefront.slide.publish` | yes | approve a submitted draft, resume a paused slide |

No default role holds a key (role seed unchanged, slide keys included: the role seed snapshot holds no `storefront.` key); a platform admin gives the editor keys to a
custom role. Publishing, archiving and approving stay with the Platform Administrator, who may
also edit, so one admin can publish their own draft. That is accepted while the protected keys
are theirs alone; if another role ever holds `storefront.page.publish` or
`storefront.navigation.approve`, refuse a publish by the draft's last editor (security review
L-2).

## Routes

Admin (`@RoutePopulation('admin')`, session, CSRF on writes): `GET storefront/admin/catalogue`,
`GET|POST storefront/admin/pages`, `GET|PUT storefront/admin/pages/:page` (`:page` is a page id
or a system key), `POST .../slots/:slot/modules`, `PUT|DELETE .../slots/:slot/modules/:id`,
`PUT .../slots/:slot/order`, `POST .../restore`, `POST .../publish`, `POST .../archive`;
`GET storefront/admin/navigation`, `PUT .../navigation/draft`, `POST .../navigation/restore`,
`POST .../navigation/approve`.

Public (`@RoutePopulation('customer')`, no session, `no-store`): `GET storefront/pages/:key`
(a never-published system page answers its template defaults), `GET storefront/landing/:slug`
(a live page, or `{ kind: 'redirect', to }` for an old slug of a live, published page or an
archived slug; an archived page never sends buyers to an archived page or to itself), `GET
storefront/navigation`, and `GET storefront/slides` (below; the only one that may be cached).

## Buyer reads (package 2, 18 Oct 2026)

The data the shelves and navigation draw lives in the module that owns it; storefront stores only
the source definition. `GET catalog/categories`: the live platform category tree (active
categories under their nearest live ancestor; id, parentId, slug, name in the Market default
locale, depth, position by name). `GET search/bestsellers` and `GET search/specials`: the
`bestsellers` and `specials` shelf sources (docs/modules/search/search.md). All anonymous,
`no-store`, default rate-limit class.

## Slide library (backend PR 1, 23 Oct 2026)

A separate per-Market library of slides (kinds `announcement`, `promotion`, `link`) that slider
positions show; pages only name a position (build brief `storefront-slider`). Tables in the
`storefront` schema: `slides`, `slide_versions` (insert-only: every draft save is a new version;
only the approval stamp is ever written to a row), `slide_placements` (the projection of the live
version, with its window, so caps and the later buyer read need no join) and `slide_position_locks`
(one row per Market and position; approving locks them so two approvals cannot both pass a cap).

- **Content** (all kinds): `title` <= 60, `body` <= 160, `ctaLabel` <= 24 (needs a link), optional
  `image` `{ ref, alt, decorative }` (a placeholder/media key; alt required unless `decorative`,
  which needs an empty alt), `textPosition` start|center|end, `textTone` light|dark, one optional
  `link` `{ type: category|product|seller|page|search, id }` that makes the whole slide clickable.
  Kind `link` requires the link. Plain text only: no markup characters, no URL; a link is never a
  URL. Checked in `domain/slides.ts`, with the basic limits repeated as CHECKs.
- **Window**: `startsAt` and `endsAt` both required; `endsAt` after `startsAt` and at most 2160
  hours (90 days in absolute time, so a daylight-saving change cannot move it) later.
- **Positions** (closed list in `domain/slide-positions.ts`): `home.hero` 8 (autoplay), `home.mid`
  4, `category.top` 4, `product.below-details` 3, `cart.below-lines` 3, `landing.top` 8
  (autoplay). `autoplay` is valid only at the two autoplay positions. A placement has a scope
  (`all|category|product|seller|page`, with `scopeId`, `includeSubcategories` for a category,
  `sortOrder`); each position allows only the scopes that make sense there.
- **Draft flow**: create (a draft), replace the draft (new version, withdraws a submission),
  restore an earlier version into a new draft, view, list (filter by status and position),
  archive. A slide is only ever found in the request's Market.
- **Copy to another Market**: there is no cross-Market admin (ADR-0018), so a copy is two steps,
  each in its own Market: `GET .../slides/:slide/copy` (read key, source Market) returns a body,
  and an editor of the other Market posts it to `POST .../slides` (edit key there). Scopes are
  reset to `all`; link targets must be checked in the target Market.
- **Approval flow**: an editor submits the draft (`storefront.slide.edit`); only
  `storefront.slide.publish` approves it, naming the draft's `versionNo` it reviewed. Approving
  stamps `approved_by`/`approved_at` on the version, sets `live_version_id`, takes the draft's
  window and flags onto the slide and rebuilds the placement projection, in one unit, after
  locking the position rows. It is refused (`storefront.slide-position-full`) when a position
  would hold more than its maximum at some instant of an overlapping window; scopes count only
  when they can show on the same page (conservative without the category tree). Replacing the
  draft again withdraws a submission; the live version keeps serving until the next approval.
  Pausing (`storefront.slide.pause`) removes the projection at once; resuming needs the publish
  key and checks the maximums again. States: draft, pending approval, scheduled, live, ended
  (from the Clock and the window), paused, archived. Every change is audited
  (`storefront.slide.create|draft-change|submit|publish|pause|resume|archive|reorder`). As with pages, the
  Platform Administrator may also edit, so one admin can approve their own draft (flagged
  `selfApproved` in the audit entry); revisit if another role ever holds the publish key.
- **Reordering the live slides** (john, 24 Oct 2026; `storefront.slide.edit`, no approval): `PUT
  storefront/admin/slides/order` with `{ position, scope?, scopeId?, slideIds[] }` saves the order of
  the slides that are approved at one position and scope (within the request's Market; for a scoped
  position, the same scope and scope id), and it takes effect at once. The list must be the whole set:
  every approved slide whose window has not ended at that position and scope (scheduled ones
  included), each once, first shown first. A duplicate, a malformed id, an id that is not a slide of
  this Market (`storefront.slide-not-found` is not leaked: it reads `validation.failed`
  `slideIds[i]: not-found`), a list that leaves a live slide out and a slide that is not live there
  (paused, draft, archived, ended, another position or scope) are refused: the first group with 400
  `validation.failed`, the last two with 409 `storefront.slide-order-mismatch` (`slideIds[i]:
  not-live-here`, or `slideIds: incomplete`), which also covers a list that went stale because an
  approval or resume changed the set. Only the order changes (sort orders 0..n-1 in list order);
  content, window, scope, autoplay, flags and every other field of a placement still need the publish
  key through submit and approve. Pinned slides are still shown before unpinned ones; the order
  applies inside each group.
  - *Where the order lives.* The version's `placements[].sortOrder` is write-once after approval, so
    it is only the starting order of a placement. The live order is the `sort_order` of the
    `slide_placements` rows (which the public read sorts by) and is also saved per slide, position
    and scope in `slide_saved_orders`, because the projection is deleted when a slide is paused and
    rebuilt when one is approved or resumed. Every projection (approve, resume) takes the saved order
    of a placement when there is one and the version's `sortOrder` only when there is none, so a
    re-approval of one slide (even a new version that still says sort order 0) does not move it. A
    saved order whose placement a new version no longer has (other position, scope or scope id) is
    forgotten by that projection, and the placement starts from the version's sort order. Residual
    case: a slide paused while the others are reordered comes back with its old number, which may
    equal another slide's; ties are broken by start time then id, deterministically, and the next
    reorder makes the numbers unique again.
  - *Locks.* One unit of work: the named slide rows in id order (`lockSlide`), then the position row
    (`lockPositions`), then the set of live placements is read (so an approval that committed before
    the lock is seen, and one after it waits). Approve, pause and resume lock one slide and then
    their positions, so no cycle is possible between a reorder and any of them, or between reorders.
  - *Audit*: `storefront.slide.reorder` (target type `storefront.slide-order`, target id the position
    key) with `before` and `after` `{ scope, scopeId, order[] }`.
  - *What buyers see and when*: there is no in-process cache of slides; the public read queries the
    projection. The order is therefore in the next uncached answer, and the read's `Cache-Control:
    public, max-age` is at most 60 seconds (and never past the next start or end), so the new order
    reaches every buyer within 60 seconds at the latest (CDN or browser caches that honour it).
  - *Follow-up (not in this PR)*: the admin app needs the current order to show. Today the list gives
    status and positions but not the sort order; a read of the live order of a position is the next
    small step.
- **Targets are checked at approval**: under the slide lock and before the stamp, `content.link` and
  every non-`all` `scopeId` are resolved in the request's Market through public facades only
  (catalog categories and published products, sellers who may sell, storefront pages that are not
  archived; a prepared search is checked by its code format). Anything missing, of another Market, or
  that could not be verified (fail closed) refuses with `storefront.slide-link-invalid` (409,
  `details.fields` lists the paths). A copy to another Market drops `content.link` and `ctaLabel`;
  the other Market's editor picks the link again. The publish audit entry carries `selfApproved`,
  true when the approver also saved the approved version.
- **Physical model and retention**: see `docs/design/data/storefront.md` (access paths, which CHECK
  guards which invariant). A slide keeps at most 100 versions; after 100 saves the editor copies the
  slide into a new one. Raising the cap needs a migration.
- **Routes** (admin, session, CSRF, `Origin` + `Sec-Fetch-Site` as every admin route):
  `GET|POST storefront/admin/slides`, `GET|PUT storefront/admin/slides/:slide`,
  `GET .../:slide/copy`, `POST .../:slide/restore`, `POST .../:slide/archive`,
  `POST .../:slide/submit|approve|pause|resume`, `PUT storefront/admin/slides/order` (declared before
  `PUT .../:slide`, so `order` is never read as a slide id).

## Public slides read (backend PR 2, 24 Oct 2026)

`GET storefront/slides?position=<key>` plus the scope the position allows (`category`, `product`,
`seller`, `page`; any other or disallowed param is a 400 `validation.failed`). Anonymous
(`@RoutePopulation('customer')`, use case `storefront.view-published-slides`), of the request's
Market only. It answers `{ position, autoplay, slides[], nextChangeAt }` where a slide is `{ id,
kind, title, body, ctaLabel, image { key, alt, decorative } | null, textPosition, textTone, href |
null, sponsored }`. Plain text only; `image.key` is a ready-made placeholder key; `href` is a site
path (`/c/..`, `/p/<id>`, `/s/<slug>`, `/l/<slug>`, or a prepared search `/offers`, `/express`,
`/certified`), never an external URL.

- Served: placement in the projection (approved, not paused or archived), window holds now, scope
  covers the page (a category slide also covers subcategories when it says so), content passes the
  checks again, sorted by the position's order and capped at its `maxActive`.
- Dropped: a slide whose link target is dead, from another Market, or whose seller is suspended
  (or has no published store address). Liveness is decided by the same `SlideTargets` port as
  approval, called with the request's context; site paths come from `LinkTargets` (category tree,
  `sellers.publishedStoreSlugs`, a new anonymous facade method).
- `autoplay` is true only when the position allows it (`home.hero`) and every shown slide asks.
- Cache: `Cache-Control: public, max-age=N`, N at most 60 and never past `nextChangeAt`;
  `Vary: X-Market-Id`. When an owner could not answer, the dependent slides are dropped and the
  answer is `no-store`. A 400 is `no-store`.

Web migration of the home banner (no data migration, no backend page change): the home hero is
always the first section. Live slides win; if there are none, the first `banner` module of the
published layout is shown as a one-slide slider (title cut to 60, an external link and its button
dropped, image only a known placeholder key); later banners stay promos.

Without JavaScript the slider still scrolls (CSS scroll-snap) and every slide is readable and
clickable, but the controls row below it (pause, arrows, picker) is an empty strip of fixed height:
it keeps its space so the page does not shift when the script adds the buttons. A slide's button
label is drawn only when the slide has a link (a label without a link is not shown). The sample hero shows
only when the slides read failed and the sample fallback is on.

## Not in v1 (follow-ups)

Read routes for product detail, seller page and list, and the `category`, `seller`, `tag` and
`manual` shelf sources; brands (no brand in catalog yet, so no brand
source or link), uploaded images (catalog media slice), CDN caching of published layouts,
preview links, per-city layouts, scheduled publishing of a future draft.
