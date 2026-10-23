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
| `storefront.slide.edit` | no | create, replace draft, restore, submit for approval, archive |
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
storefront/navigation`.

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
  (`storefront.slide.create|draft-change|submit|publish|pause|resume|archive`). As with pages, the
  Platform Administrator may also edit, so one admin can approve their own draft; revisit if
  another role ever holds the publish key.
- **Routes** (admin, session, CSRF, `Origin` + `Sec-Fetch-Site` as every admin route):
  `GET|POST storefront/admin/slides`, `GET|PUT storefront/admin/slides/:slide`,
  `GET .../:slide/copy`, `POST .../:slide/restore`, `POST .../:slide/archive`,
  `POST .../:slide/submit|approve|pause|resume`.

## Not in v1 (follow-ups)

Read routes for product detail, seller page and list, and the `category`, `seller`, `tag` and
`manual` shelf sources; brands (no brand in catalog yet, so no brand
source or link), uploaded images (catalog media slice), CDN caching of published layouts,
preview links, per-city layouts, scheduled publishing of a future draft.
