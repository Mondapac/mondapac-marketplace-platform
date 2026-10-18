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

No default role holds a key (role seed unchanged); a platform admin gives the editor keys to a
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

## Not in v1 (follow-ups)

Read routes the shelves and navigation need (public category tree, product detail, seller page
and list, best-sellers and special-price lists), brands (no brand in catalog yet, so no brand
source or link), uploaded images (catalog media slice), CDN caching of published layouts,
preview links, per-city layouts, scheduled publishing of a future draft.
