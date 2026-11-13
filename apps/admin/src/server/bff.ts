// The panel server's relay to the API (ADR-0034 decision 3). Pure functions over `Request` and
// `Response`, so they are tested without a server. The relay forwards an allowlist of paths and
// headers, sets `x-market-id` from the request host, and refuses an unsafe request that is not
// same-origin, because the API's own origin check is fail-open when the headers are absent.

import 'server-only';
import {
  CLIENT_ADDRESS_HEADER,
  MissingClientAddressError,
  signForRequest,
} from '@mondapac/panel-server/signer';
import type { PanelConfig, PanelHost } from './config.ts';

/** The paths this panel may reach, by method (its own population's identity routes). */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  GET: new Set([
    'identity/admin/session',
    'identity/admin/sellers',
    'payments/admin/connected-accounts',
    // The Market's orders (ordering), read-only: the list; one order is read by the page server.
    'ordering/admin/orders',
    // The Market's buyer assistant settings, read again after another admin saved first.
    'assistant/admin/settings',
    // The Market's support email, read again after another admin saved first.
    'notifications/admin/support-contact',
    // The topbar bell (in-app notifications package 3): the list (query: `show`, `before`) and
    // the unread count with the newest unread notice.
    'notifications/admin/notices',
    'notifications/admin/notices/unread-count',
    // The fleet-selection models, the active model per method and the fleets (shipping), read
    // again after a save.
    'shipping/admin/fleet-selection',
    // The storefront slide library (storefront), read-only: the list (query: `state`, `position`);
    // one slide is read by the page server.
    'storefront/admin/slides',
    // The saved order of the live slides of one position (storefront), read-only (query:
    // `position`, `scope`, `scopeId`). A fixed path, so `order` is never read as a slide id: the
    // slide route reads a UUID only, and one slide is read by the page server.
    'storefront/admin/slides/order',
    // The storefront pages (storefront), read-only: the list, and the templates and modules the
    // new-page form offers. One page is read by the page server.
    'storefront/admin/pages',
    'storefront/admin/catalogue',
    // The Market's wallet switch, and the admin credit requests (query: `status`, `cursor`, `limit`).
    'wallet/admin/settings',
    // The Market's tax strategies and the active one (tax), read again after a change.
    'tax/admin/strategies',
    'wallet/admin/credit-requests',
    // The payment dispute cases (commission-payouts), read-only list (query: `filter`, `cursor`,
    // `limit`); one case is read by the page server and again after a decision.
    'commission-payouts/admin/disputes',
    // The buyer-review moderation queue (reviews), read-only list (query: `tab`, `cursor`,
    // `limit`); one review is read by its dialog and again after an action.
    'reviews/admin/moderation',
    // The seller payouts (commission-payouts, package 6d), read-only list (query: `status`,
    // `cursor`, `limit`); one payout is read by the page server and again by the approve dialog.
    'commission-payouts/admin/payouts',
    // The delivery settings of the Market (shipping), read again after a conflict.
    'shipping/admin/delivery-settings',
    // The service areas with their names (sellers, ADR-0041), read-only.
    'sellers/admin/service-areas',
    // The product form's certificates card (certification): what the form's dialog offers (types
    // with their issuers). The certificates of one product and one certificate are read by id below.
    'certification/admin/product-certificates/options',
    // The marketplace product list (catalog), read-only (query: `view`, `q`, the filters, `sort`,
    // `direction`, `page`, `pageSize`); and the public category tree, which names its filter.
    'catalog/admin/products',
    'catalog/categories',
    // What the platform product create form offers (catalog): the Market's types and languages.
    'catalog/admin/platform-products/options',
    // The export of the product list as a file (catalog): the chosen ids or the list's own query.
    'catalog/admin/products/export',
    // Import products (catalog): the CSV and XLSX templates and the admin's current import.
    'catalog/admin/platform-imports/template',
    'catalog/admin/platform-imports/current',
    // The saved views of the product list (catalog), read-only (query: `listKey`).
    'catalog/admin/saved-filters',
    // The saved views of the order list (ordering; query: `listKey`).
    'ordering/admin/saved-filters',
    // The buyer account deletion setting, read again after a conflict, and the pending deletion
    // requests (customers; query: `cursor`, `limit`).
    'customers/admin/account-deletion-settings',
    'customers/admin/deletion-requests',
    // "View history" of a settings page (query: `after`, `limit`): when, who by display name and
    // which fields changed, from the audit log.
    'assistant/admin/settings/history',
    'notifications/admin/support-contact/history',
    'shipping/admin/delivery-settings/history',
    'shipping/admin/fleet-selection/history',
    'wallet/admin/settings/history',
    // The promotions settings page (promotions): the Market switch, the first-order discount and
    // the free-delivery thresholds, read again after a save.
    'promotions/admin/settings',
    'promotions/admin/first-order',
    'promotions/admin/free-shipping',
    // The editable Market settings (settings; List paging), read again after a conflict.
    'settings/admin/market-settings',
    // The blog posts of the Market (blog; query: `status`, `kind`, `owner`, `page`), read only.
    'blog/admin/posts',
    // The blog categories and tags the editor offers (blog), read only.
    'blog/admin/taxonomy',
    // The brands (catalog; query: `status`, `search`, `afterId`, `limit`) and the brand merge
    // queue. One brand is not read by the panel: the list rows carry the version a change needs.
    'catalog/admin/brands',
    'catalog/admin/brands/merge-queue',
    // The category tree and one category with its path and history (catalog), read-only.
    'catalog/admin/categories',
    // The export of the category tree as a file (catalog, categories C7a; query: `format`,
    // `status`, `q`).
    'catalog/admin/category-tree/export',
    // The business activities (catalog; query: `status`, `search`, `afterId`, `limit`).
    'catalog/admin/business-activities',
    // The product tags (catalog topics; query: `status`, `group`, `search`, `afterId`, `limit`).
    'catalog/admin/topics',
    // The attributes (catalog; query: `search`, `type`, `status`, `usedIn`, `missing`, `afterId`,
    // `limit`) and the feature sets (attribute families), read only (attributes package A1).
    'catalog/admin/attributes',
    'catalog/admin/feature-sets',
    // The value suggestions waiting for a decision (catalog, attributes A5).
    'catalog/admin/attribute-suggestions',
    // The sizes sellers asked for, waiting for a decision (catalog, variants V7).
    'catalog/admin/variant-requests',
    // The seller category proposals waiting for a decision (catalog, categories C9a; query:
    // `afterId`, `limit`).
    'catalog/admin/category-proposals',
    // The tag suggestions waiting for a decision (catalog topics, product tags T5).
    'catalog/admin/topic-suggestions',
    // Requests to turn off Material waiting for a second administrator (attributes A2 part 3).
    'catalog/admin/attribute-relaxations',
    // Requests to archive a Material attribute waiting for a second administrator (attributes A8).
    'catalog/admin/attribute-archive-requests',
    // The variant types and the variants of live products, their issue counts and their export
    // (catalog, variants V6; query of the list: `q`, `typeCode`, `issue`, `after`, `limit`).
    'catalog/admin/variant-types',
    'catalog/admin/variants',
    'catalog/admin/variants/issue-counts',
    'catalog/admin/variants/export',
    // The report of published products missing a required detail (catalog, attributes A4;
    // query: `sellerId`, `familyCode`, `afterId`, `limit`).
    'catalog/admin/reports/products-missing-details',
    // "Write with AI" (catalog, AIS-03): whether the writer is on for this admin, and the model
    // setup read by the Settings AI card (on/off kill switch, key set or not, model ids; never
    // the key). The AI settings (settings; keys settings.ai.view / settings.ai.manage).
    'catalog/admin/description-writer',
    'catalog/admin/description-writer/model-setup',
    'settings/admin/ai',
  ]),
  // The Market's support email (notifications): a body of one field, set by an admin.
  PUT: new Set([
    'notifications/admin/support-contact',
    // The signed-in admin's own display name (profile).
    'identity/admin/profile/display-name',
    // The signed-in admin's own time zone and language (profile).
    'identity/admin/profile/preferences',
    // The Market's buyer assistant settings (assistant): every field with `expectedVersion`.
    'assistant/admin/settings',
    // Fleet selection (shipping): the whole page in one batch (the active model per delivery
    // method and the reliability per fleet), with `expectedVersion`.
    'shipping/admin/fleet-selection',
    // The order of the live slides of one position (storefront). A fixed path, so `order` is never
    // read as a slide id: the slide route below takes a UUID only.
    'storefront/admin/slides/order',
    // The Market's wallet switch (wallet), behind a fresh two-step code.
    'wallet/admin/settings',
    // The delivery settings of the Market (shipping): the whole set, with `expectedVersion`.
    'shipping/admin/delivery-settings',
    // The buyer account deletion setting (customers), behind a fresh two-step code.
    'customers/admin/account-deletion-settings',
    // One editable Market setting (settings): code, value and `expectedVersion`.
    'settings/admin/market-settings',
    // One AI setting (settings): code, value and `expectedVersion`; protected key
    // `settings.ai.manage`, so it may ask a fresh two-step code.
    'settings/admin/ai',
    // The promotions Market switch and the first-order discount (promotions); a monthly budget
    // above the Market threshold asks a fresh two-step code. The zone thresholds are below.
    'promotions/admin/settings',
    'promotions/admin/first-order',
  ]),
  DELETE: new Set([]),
  POST: new Set([
    // A description draft from the "Write with AI" modal (catalog, AIS-03); nothing is stored.
    'catalog/admin/description-writer/drafts',
    // "Email sellers" from the Missing details report: the picked product ids, 'dryRun' for the
    // preview (catalog, attributes A4-4).
    'catalog/admin/reports/products-missing-details/email-sellers',
    // The signed-in admin's other sessions are ended; this one stays (profile).
    'identity/admin/profile/sessions/sign-out-others',
    'identity/admin/sign-in',
    'identity/admin/second-factor',
    'identity/admin/sign-out',
    'identity/admin/invitations',
    'identity/admin/password-reset-email',
    'identity/admin/reset-password',
    // The signed-in admin's own password; the body carries a code from the app.
    'identity/admin/change-password',
    // The signed-in admin moves their own authenticator to a new device: a code from the current
    // app starts it, a code from the new one completes it (the session continues with a new
    // cookie, which the relay passes on).
    'identity/admin/second-factor/replacement',
    'identity/admin/second-factor/replacement/confirm',
    'identity/admin/invitation/enrolment',
    'identity/admin/invitation/accept',
    'identity/admin/roles',
    // A read with the address in the body, so it stays out of URLs and logs (slice 8d).
    'identity/admin/customers/lookup',
    // A read with the search term in the body, so a POST (sellers design 7.8).
    'sellers/admin/list',
    // The names of one service area, set or restored (sellers, ADR-0041).
    'sellers/admin/service-areas/names',
    'notifications/admin/notices/read-all',
    // A new fleet-selection model (shipping).
    'shipping/admin/fleet-selection/models',
    // A new tax strategy, and the choice of the active one (tax; protected key).
    'tax/admin/strategies',
    'tax/admin/strategies/active',
    // A new storefront slide, as a draft (storefront).
    'storefront/admin/slides',
    // A new storefront page from a template, as a draft (storefront).
    'storefront/admin/pages',
    // Admin store credit (wallet), behind a fresh two-step code.
    'wallet/admin/credits',
    // A fresh two-step code for one admin action (identity).
    'identity/admin/step-up/verify',
    // A new blog post, as a draft (blog).
    'blog/admin/posts',
    // A new brand (catalog), and keeping a group of the merge queue apart.
    'catalog/admin/brands',
    'catalog/admin/brands/merge-queue/dismiss',
    // A new business activity (catalog).
    'catalog/admin/business-activities',
    // A new product tag (catalog topics).
    'catalog/admin/topics',
    // A new platform category, as a hidden one (catalog, categories C3).
    'catalog/admin/categories',
    // The category tree import (catalog, categories C7a): check a file, then apply it. Both carry
    // the file as base64 and take the larger upload cap.
    'catalog/admin/category-tree/import/dry-run',
    'catalog/admin/category-tree/import/apply',
    // Add an attribute as a draft (catalog, attributes package A2).
    'catalog/admin/attributes',
    // The Bulk action menu of the product list (catalog): Activate, Deactivate and Delete over
    // the chosen products (at most 200 ids) or the whole filter; the body is capped at 16 KB.
    'catalog/admin/products/bulk',
    // Import products (catalog): the checked file, as base64 in a JSON body (the one path with a
    // larger body cap, see UPLOAD_PATH).
    'catalog/admin/platform-imports',
    // A new platform product, as a draft (catalog): the body names the type only.
    'catalog/admin/platform-products',
    // Save the product list's current view as a tab (catalog): a closed body, for me or everyone.
    'catalog/admin/saved-filters',
    // A new manufacturer certificate, as a draft (certification): the body names the type only.
    'certification/admin/product-certificates',
    // A new issuer, as Proposed (certification issuer registry).
    'certification/admin/issuers',
    // Save the order list's current view as a tab (ordering): a closed body, for me or everyone.
    'ordering/admin/saved-filters',
  ]),
};

/**
 * Paths with one resource id (`:id`, a UUID), by method. Still exact: each segment must match
 * the template, and the id must be a UUID, so no other path shape reaches the API.
 */
const ALLOWED_WITH_ID: Readonly<Record<string, readonly string[]>> = {
  POST: [
    // One order (ordering, order detail decisions 1 and 3): cancel and refund the whole order,
    // refund one seller order, and write an internal note. The notes and the order are read by the
    // page server.
    'ordering/admin/orders/:id/cancel',
    'ordering/admin/orders/:id/seller-orders/:id/refunds',
    'ordering/admin/orders/:id/notes',
    // Start, resume or discard one checked import (catalog).
    'catalog/admin/platform-imports/:id/start',
    'catalog/admin/platform-imports/:id/resume',
    'catalog/admin/platform-imports/:id/discard',
    'identity/admin/accounts/:id/disable',
    'identity/admin/accounts/:id/enable',
    'identity/admin/accounts/:id/role',
    'identity/admin/accounts/:id/second-factor/reset',
    'identity/admin/customers/:id/disable',
    'identity/admin/customers/:id/enable',
    'identity/admin/invitations/:id/resend',
    'identity/admin/invitations/:id/revoke',
    'identity/admin/sellers/:id/invitations',
    'identity/admin/sellers/:id/second-factor/reset',
    // Queue a recount of one seller's health (sellers, seller health package 5).
    'sellers/admin/:id/health/recalculate',
    'sellers/admin/:id/review/approve',
    'sellers/admin/:id/review/reject',
    'pricing/admin/price-holds/:id/approve',
    'pricing/admin/price-holds/:id/reject',
    'catalog/admin/offers/:id/approve',
    'catalog/admin/offers/:id/request-changes',
    // Approve or send back a pending product version, naming the version seen (catalog, product
    // version review); take a photo down with a reason (cannot be undone).
    'catalog/admin/products/:id/revisions/:id/approve',
    'catalog/admin/products/:id/revisions/:id/request-changes',
    'catalog/admin/products/:id/images/:id/take-down',
    // Submit (publish) a platform product's working copy (catalog).
    'catalog/admin/platform-products/:id/submit',
    // Turn a Simple platform product into one with sizes, once (catalog, variants V9).
    'catalog/admin/platform-products/:id/add-sizes',
    // Discard a platform product that was never submitted (catalog).
    'catalog/admin/platform-products/:id/discard',
    // A manufacturer certificate (certification): add its document, then send it for review, each
    // with the record version read. Approve, reject, suspend and revoke are not reachable here.
    'certification/admin/product-certificates/:id/documents',
    'certification/admin/product-certificates/:id/submit',
    // Activate an issuer with the expert's approval, under the version read (certification).
    'certification/admin/issuers/:id/activate',
    // Add a photo to a platform product's library (catalog, P1): a base64 photo, so the body cap
    // of this path is the larger image one.
    'catalog/admin/platform-products/:id/images',
    // A brand (catalog): approve a seller's proposal, archive (also turns a proposal down), and
    // merge other brands into it.
    'catalog/admin/brands/:id/approve',
    'catalog/admin/brands/:id/archive',
    'catalog/admin/brands/:id/merge',
    // Publish or discard a draft attribute, with the version seen (catalog, attributes A2).
    'catalog/admin/attributes/:id/publish',
    'catalog/admin/attributes/:id/discard',
    // A platform category (catalog, categories C3): move up or down, hide, show, new URL name,
    // and discard a category that never went live. Each names the tree version the page read.
    'catalog/admin/categories/:id/reorder',
    'catalog/admin/categories/:id/hide',
    'catalog/admin/categories/:id/show',
    'catalog/admin/categories/:id/change-slug',
    'catalog/admin/categories/:id/discard',
    // Remove a category's image, with the category version seen (catalog, categories C3c).
    'catalog/admin/categories/:id/image/remove',
    // Move, merge and archive a platform category (catalog, categories C4a: protected key
    // `catalog.category-tree.restructure`), each with the tree version and a reason note.
    'catalog/admin/categories/:id/move',
    'catalog/admin/categories/:id/merge',
    'catalog/admin/categories/:id/archive',
    // Approve or reject a seller's category proposal with the version seen (catalog, categories
    // C9a: key `catalog.category-proposal.decide`, a prepared reason code on reject), and promote
    // or merge a seller's shelf (protected key `catalog.seller-category.promote-merge`).
    'catalog/admin/category-proposals/:id/approve',
    'catalog/admin/category-proposals/:id/reject',
    'catalog/admin/shelves/:id/promote',
    'catalog/admin/shelves/:id/merge',
    // Decide a seller's value suggestion with the version seen (catalog, attributes A5).
    'catalog/admin/attribute-suggestions/:id/approve',
    'catalog/admin/attribute-suggestions/:id/map',
    'catalog/admin/attribute-suggestions/:id/reject',
    // Decide a seller's size request with the version seen (catalog, variants V7).
    'catalog/admin/variant-requests/:id/approve',
    'catalog/admin/variant-requests/:id/map',
    'catalog/admin/variant-requests/:id/decline',
    // Decide a seller's tag suggestion with the version seen (catalog topics, product tags T5).
    'catalog/admin/topic-suggestions/:id/approve',
    'catalog/admin/topic-suggestions/:id/map',
    'catalog/admin/topic-suggestions/:id/reject',
    // Ask to turn off Material on a published attribute, and confirm or withdraw such a request
    // (catalog, attributes A2 part 3: two administrators).
    'catalog/admin/attributes/:id/relaxation-requests',
    'catalog/admin/attribute-relaxations/:id/confirm',
    'catalog/admin/attribute-relaxations/:id/cancel',
    // Merge two values, archive an attribute, ask to archive a material one, and confirm such a
    // request (catalog, attributes A8: key `catalog.attribute.restructure`).
    'catalog/admin/attributes/:id/merge-values',
    'catalog/admin/attributes/:id/merge',
    'catalog/admin/attributes/:id/convert',
    'catalog/admin/attributes/:id/archive',
    'catalog/admin/attributes/:id/archive-requests',
    'catalog/admin/attribute-archive-requests/:id/confirm',
    'notifications/admin/notices/:id/read',
    // A storefront slide's approval side and its other changes (storefront): send the draft for
    // approval, approve it, pause, resume, archive, and copy an earlier version into the draft.
    'storefront/admin/slides/:id/submit',
    // Send a blog post's draft for review (blog); the backend's automatic checks may refuse.
    'blog/admin/posts/:id/submit',
    // A reviewer's two decisions on the version in review (blog): approve it (a self-approval asks
    // for a two-step code) or send it back with a note.
    'blog/admin/posts/:id/approve',
    'blog/admin/posts/:id/request-changes',
    'storefront/admin/slides/:id/approve',
    'storefront/admin/slides/:id/pause',
    'storefront/admin/slides/:id/resume',
    'storefront/admin/slides/:id/archive',
    'storefront/admin/slides/:id/restore',
    // Approve or reject another admin's credit request (wallet), behind a two-step code.
    'wallet/admin/credit-requests/:id/approve',
    'wallet/admin/credit-requests/:id/reject',
    // Who bears a lost chargeback, per seller order (commission-payouts), behind a two-step code.
    'commission-payouts/admin/disputes/:id/seller-orders/:id/decision',
    // Approve a seller payout that waits (commission-payouts), behind a two-step code; the body
    // echoes the transfer amount the admin saw.
    'commission-payouts/admin/payouts/:id/approve',
    // Place a hold on a seller, and release one (commission-payouts), behind a two-step code.
    'commission-payouts/admin/sellers/:id/payout-holds',
    'commission-payouts/admin/payout-holds/:id/release',
    // Delete a buyer's account for them, from a support ticket (customers), behind a two-step code.
    'customers/admin/buyers/:id/deletion-requests',
    // Publish, hide, restore or remove a buyer review, or dismiss its reports (reviews); all but
    // the dismissal are behind a two-step code.
    'reviews/admin/moderation/:id/publish',
    'reviews/admin/moderation/:id/hide',
    'reviews/admin/moderation/:id/restore',
    'reviews/admin/moderation/:id/remove',
    'reviews/admin/moderation/:id/dismiss-reports',
  ],
  PUT: [
    // Change a feature set: names, groups and requirement levels, with the version read
    // (catalog, attributes A4).
    'catalog/admin/feature-sets/:id',
    // Set the feature set and filters of a category, with the version read (attributes A4).
    'catalog/admin/categories/:id/attribute-links',
    // Set or replace a category's image, with the category version seen (catalog, categories
    // C3c). A base64 picture: the body cap of this path is the larger image one.
    'catalog/admin/categories/:id/image',
    'identity/admin/roles/:id',
    // A saved view of the order list: its name and who can use it (ordering).
    'ordering/admin/saved-filters/:id',
    'sellers/admin/:id/review/manual-register-check',
    // Whether the seller may propose categories (sellers, SEL-26; categories C9-0).
    'sellers/admin/:id/category-proposals',
    // Whether the seller may use AI writing help (sellers, SEL-25), set; the page server reads it.
    'sellers/admin/:id/ai-access',
    // The delivery methods the seller supports (shipping), set from the seller review page.
    'shipping/admin/sellers/:id/delivery-methods',
    // A tax strategy edited by its id (tax).
    'tax/admin/strategies/:id',
    // A fleet-selection model edited by its id (shipping).
    'shipping/admin/fleet-selection/models/:id',
    // The seller's own commission rate (commission-payouts), set from the seller review page.
    'commission-payouts/admin/sellers/:id/commission-rate',
    // The seller's own payout terms (commission-payouts), behind a two-step code.
    'commission-payouts/admin/sellers/:id/payout-terms',
    // A storefront slide's whole draft (storefront).
    'storefront/admin/slides/:id',
    // A blog post's whole draft: the content and the address (blog).
    'blog/admin/posts/:id/draft',
    // The live status of a published blog event and its note for readers (blog).
    'blog/admin/posts/:id/event-status',
    // The whole content of a brand, with the version seen (catalog).
    'catalog/admin/brands/:id',
    // The whole content of a business activity, with the version seen (catalog).
    'catalog/admin/business-activities/:id',
    // The whole content of a product tag, with the version seen (catalog topics).
    'catalog/admin/topics/:id',
    // The whole content of an attribute, a new revision, with the version seen (attributes A2).
    'catalog/admin/attributes/:id',
    // How buyers choose a variant type, the whole settings with the version seen (variants V6).
    'catalog/admin/variant-types/:id/settings',
    // A saved view's name and who can use it (catalog).
    'catalog/admin/saved-filters/:id',
    // The working copy of a platform product, saved as a draft (catalog).
    'catalog/admin/platform-products/:id/draft',
    // The draft of a manufacturer certificate, with the record version read (certification).
    'certification/admin/product-certificates/:id/draft',
  ],
  // The details of one platform category (catalog, categories C3), with the version seen.
  PATCH: ['catalog/admin/categories/:id'],
  DELETE: [
    'identity/admin/roles/:id',
    // A tax strategy that is not active (tax).
    'tax/admin/strategies/:id',
    'commission-payouts/admin/sellers/:id/commission-rate',
    // Back to the Market's payout terms; the version and reason code are in the query.
    'commission-payouts/admin/sellers/:id/payout-terms',
    // Cancel a pending buyer deletion request (customers), behind a two-step code.
    'customers/admin/deletion-requests/:id',
    // A saved view of the product list (catalog).
    'catalog/admin/saved-filters/:id',
    // Delete an unused photo of a platform product (catalog, P1).
    'catalog/admin/platform-products/:id/images/:id',
    // A saved view of the order list (ordering).
    'ordering/admin/saved-filters/:id',
  ],
  // The seller's commission rate and ledger, read from the seller review page.
  GET: [
    // One category with its path and history, and the impact of a change on its subtree
    // (catalog, read-only; the impact takes the `action`).
    'catalog/admin/categories/:id',
    'catalog/admin/categories/:id/impact',
    // One seller's shelves, every status (catalog, categories C9a), read-only.
    'catalog/admin/sellers/:id/shelves',
    // One blog post with its working and live versions, and its automatic checks (blog).
    'blog/admin/posts/:id',
    'blog/admin/posts/:id/checks',
    // One platform product with its working copy, for the product form (catalog).
    'catalog/admin/platform-products/:id',
    // How many offers of other sellers go off sale if sizes are added (catalog, variants V9).
    'catalog/admin/platform-products/:id/add-sizes-impact',
    // The manufacturer certificates that name one product, one certificate, and its status history
    // (certification), read by the product form's certificates card.
    'certification/admin/product-certificates/for-product/:id',
    // The expert approval of one issuer (certification): an audited read, edit permission.
    'certification/admin/issuers/:id/expert-reference',
    'certification/admin/product-certificates/:id',
    'certification/admin/product-certificates/:id/history',
    // The photo library of a platform product, for the form's images card (catalog, P1).
    'catalog/admin/platform-products/:id/images',
    // The primary photo of a listed product, thumbnail size only (catalog).
    'catalog/admin/products/:id/images/:id/thumb',
    // A product version's photo opened large, for its review (catalog).
    'catalog/admin/products/:id/images/:id/large',
    // The current image of a category, medium size only (catalog, categories C3c).
    'catalog/admin/categories/:id/images/:id/medium',
    // One import and its report CSV (catalog): the report takes the query `kind`.
    'catalog/admin/platform-imports/:id',
    'catalog/admin/platform-imports/:id/report',
    // One business activity (catalog), read again after a conflict.
    'catalog/admin/business-activities/:id',
    // One product tag (catalog topics).
    'catalog/admin/topics/:id',
    // One attribute with its values, uses and history, and one feature set (catalog, package A1).
    'catalog/admin/attributes/:id',
    // What merging values or archiving an attribute reaches (catalog, attributes A8).
    'catalog/admin/attributes/:id/impact',
    'catalog/admin/feature-sets/:id',
    // The feature set and filters of one category, with what it ends up with (attributes A4).
    'catalog/admin/categories/:id/attribute-links',
    // One variant type with its options and settings (catalog, variants V6).
    'catalog/admin/variant-types/:id',
    'commission-payouts/admin/sellers/:id/commission-rate',
    'commission-payouts/admin/sellers/:id/ledger',
    // A storefront slide as a package to create in another Market (storefront).
    'storefront/admin/slides/:id/copy',
    // One customer's wallet and the caller's credit caps (wallet), for the issue screen.
    'wallet/admin/customers/:id',
    // One dispute case, read again after a decision (commission-payouts).
    'commission-payouts/admin/disputes/:id',
    // One buyer review for the moderator dialog (reviews).
    'reviews/admin/moderation/:id',
    // One seller payout (commission-payouts), read by the approve dialog.
    'commission-payouts/admin/payouts/:id',
    // A seller's payout terms and holds (commission-payouts), read again after a change.
    'commission-payouts/admin/sellers/:id/payout-terms',
    'commission-payouts/admin/sellers/:id/payout-holds',
    // The delivery methods of a seller (shipping), read again after a conflict.
    'shipping/admin/sellers/:id/delivery-methods',
  ],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only GET paths whose query string crosses to the API, and the keys that may cross. */
const QUERY_KEYS: Readonly<Record<string, readonly string[]>> = {
  'identity/admin/sellers': ['state', 'limit', 'after'],
  'payments/admin/connected-accounts': ['status', 'cursor'],
  // The page mode and the filters of the orders list (the API validates every value).
  'ordering/admin/orders': [
    'status',
    'cursor',
    'page',
    'pageSize',
    'sort',
    'direction',
    'paymentState',
    'fulfilment',
    'sellerId',
    'from',
    'to',
  ],
  'ordering/admin/saved-filters': ['listKey'],
  'notifications/admin/notices': ['show', 'before'],
  'storefront/admin/slides': ['state', 'position'],
  'storefront/admin/slides/order': ['position', 'scope', 'scopeId'],
  'blog/admin/posts': ['status', 'kind', 'owner', 'page'],
  'wallet/admin/credit-requests': ['status', 'cursor', 'limit'],
  'commission-payouts/admin/disputes': ['filter', 'cursor', 'limit'],
  'reviews/admin/moderation': ['tab', 'cursor', 'limit'],
  'catalog/admin/products': [
    'view',
    'q',
    'scope',
    'status',
    'categoryId',
    'typeCode',
    'sellerId',
    'sort',
    'direction',
    'page',
    'pageSize',
  ],
  'catalog/admin/saved-filters': ['listKey'],
  'catalog/admin/category-tree/export': ['format', 'status', 'q'],
  'catalog/admin/products/export': [
    'format',
    'columns',
    'ids',
    'view',
    'q',
    'scope',
    'status',
    'categoryId',
    'typeCode',
    'sellerId',
  ],
  'commission-payouts/admin/payouts': ['status', 'cursor', 'limit'],
  'customers/admin/deletion-requests': ['cursor', 'limit'],
  'catalog/admin/brands': ['status', 'search', 'afterId', 'limit'],
  // The category tree, narrowed to the categories of one feature set (categories, A4).
  'catalog/admin/categories': ['featureSetId'],
  'catalog/admin/category-proposals': ['afterId', 'limit'],
  'catalog/admin/business-activities': ['status', 'search', 'afterId', 'limit'],
  'catalog/admin/topics': ['status', 'group', 'search', 'afterId', 'limit'],
  'catalog/admin/attributes': ['search', 'type', 'status', 'usedIn', 'missing', 'afterId', 'limit'],
  'catalog/admin/variant-requests': ['limit'],
  'catalog/admin/variants': ['q', 'typeCode', 'issue', 'after', 'limit'],
  'catalog/admin/variants/issue-counts': ['typeCode'],
  'catalog/admin/variants/export': ['format', 'q', 'typeCode', 'issue'],
  'catalog/admin/reports/products-missing-details': ['sellerId', 'familyCode', 'afterId', 'limit'],
};
/** Query values that must have a shape to cross; a value of another shape is dropped. */
const QUERY_SHAPES: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  // The cursor is the API's own: epoch milliseconds, a dot and a request id.
  'wallet/admin/credit-requests': {
    status: /^(pending|decided|granted)$/,
    limit: /^[0-9]{1,3}$/,
    cursor: /^[0-9]{1,15}\.[0-9a-f-]{36}$/,
  },
  'reviews/admin/moderation': {
    tab: /^(held|reported|actioned)$/,
    limit: /^[0-9]{1,3}$/,
    // The API's own cursor: epoch milliseconds of the submission, an underscore and the review id.
    cursor: /^[0-9]{1,15}_[0-9a-f-]{36}$/,
  },
  'commission-payouts/admin/disputes': {
    filter: /^(needs-response|decision-needed|under-review|won|closed)$/,
    limit: /^[0-9]{1,3}$/,
    // The API's own cursor: epoch milliseconds of the opening, a dot and the dispute id.
    cursor: /^[0-9]{1,15}\.[0-9a-f-]{36}$/,
  },
  'catalog/admin/products': {
    view: /^(active|all|inactive)$/,
    scope: /^(PLATFORM|SELLER)$/,
    status: /^(published|paused|unpublished|withdrawn|retired|matched)$/,
    categoryId: UUID,
    typeCode: /^[a-z0-9][a-z0-9_-]{0,63}$/,
    sellerId: UUID,
    sort: /^(name|updated|created)$/,
    direction: /^(asc|desc)$/,
    page: /^[1-9][0-9]{0,3}$/,
    pageSize: /^([1-9][0-9]?|100)$/,
  },
  'catalog/admin/products/export': {
    format: /^(csv|xlsx)$/,
    columns:
      /^(code|offers|updated|type|scope|seller|created|tags)(,(code|offers|updated|type|scope|seller|created|tags)){0,7}$/,
    // At most 200 product ids, the cap of the bulk action.
    ids: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,199}$/i,
    view: /^(active|all|inactive)$/,
    scope: /^(PLATFORM|SELLER)$/,
    status: /^(published|paused|unpublished|withdrawn|retired|matched)$/,
    categoryId: UUID,
    typeCode: /^[a-z0-9][a-z0-9_-]{0,63}$/,
    sellerId: UUID,
  },
  'catalog/admin/variant-requests': { limit: /^([1-9][0-9]?|100)$/ },
  'catalog/admin/category-tree/export': {
    format: /^(csv|xlsx)$/,
    status: /^(active|hidden|merged|archived)(,(active|hidden|merged|archived)){0,3}$/,
  },
  'catalog/admin/variants': {
    typeCode: /^[a-z][a-z0-9_-]{0,63}$/,
    issue: /^(no-seller-selling|missing-gtin|duplicate-gtin|no-image|missing-language)$/,
    after: UUID,
    limit: /^([1-9][0-9]?|100)$/,
  },
  'catalog/admin/variants/issue-counts': { typeCode: /^[a-z][a-z0-9_-]{0,63}$/ },
  'catalog/admin/variants/export': {
    format: /^(csv|xlsx)$/,
    typeCode: /^[a-z][a-z0-9_-]{0,63}$/,
    issue: /^(no-seller-selling|missing-gtin|duplicate-gtin|no-image|missing-language)$/,
  },
  'catalog/admin/saved-filters': { listKey: /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/ },
  'ordering/admin/saved-filters': { listKey: /^admin\.ordering\.orders$/ },
  'commission-payouts/admin/payouts': {
    status: /^(awaiting-approval|approved|instructing|instructed|paid|failed|not-sent)$/,
    limit: /^[0-9]{1,3}$/,
    // The API's own cursor: epoch milliseconds of the creation, a dot and the payout id.
    cursor: /^[0-9]{1,15}\.[0-9a-f-]{36}$/,
  },
  'customers/admin/deletion-requests': {
    limit: /^[0-9]{1,3}$/,
    // The API's own cursor: epoch milliseconds of the scheduled date, a dot and the request id.
    cursor: /^[0-9]{1,15}\.[0-9a-f-]{36}$/,
  },
  'catalog/admin/categories': { featureSetId: UUID },
  'catalog/admin/category-proposals': { afterId: UUID, limit: /^[0-9]{1,2}$/ },
  'catalog/admin/brands': {
    status: /^(draft|active|archived)$/,
    limit: /^[0-9]{1,3}$/,
    afterId: UUID,
  },
  // `targetId` is the picked new parent or merge target, or `top` for a department (C4b).
  'catalog/admin/categories/:id/impact': {
    action: /^(move|merge|archive)$/,
    // `top` is exact (the API maps only `top` to a department); an id may be in either case.
    targetId:
      /^(?:top|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  },
  'catalog/admin/business-activities': {
    status: /^(active|inactive)$/,
    limit: /^[0-9]{1,3}$/,
    afterId: UUID,
  },
  'catalog/admin/topics': {
    status: /^(active|archived)$/,
    group: /^(occasion|cuisine|use)$/,
    limit: /^[0-9]{1,3}$/,
    afterId: UUID,
  },
  'catalog/admin/reports/products-missing-details': {
    sellerId: UUID,
    familyCode: /^[a-z][a-z0-9_-]{0,63}$/,
    limit: /^[0-9]{1,3}$/,
    afterId: UUID,
  },
  'catalog/admin/attributes': {
    type: /^(text|long-text|integer|decimal|boolean|date|select|multi-select|measure)$/,
    status: /^(draft|active|archived)$/,
    usedIn: UUID,
    missing: /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/,
    limit: /^[0-9]{1,3}$/,
    afterId: UUID,
  },
  'notifications/admin/notices': { show: /^(unread|read|all)$/, before: UUID },
  'storefront/admin/slides': {
    state: /^(draft|pending|scheduled|live|ended|paused|archived)$/,
    position: /^[a-z]+(?:\.[a-z-]+)+$/,
  },
  'blog/admin/posts': {
    status:
      /^(draft|in_review|changes_requested|approved|scheduled|published|unpublished|archived)$/,
    kind: /^(product|brand|event|news)$/,
    owner: /^(platform|seller)$/,
    page: /^[0-9]{1,4}$/,
  },
  'storefront/admin/slides/order': {
    position: /^[a-z]+(?:\.[a-z-]+)+$/,
    scope: /^(all|category|product|seller|page)$/,
    scopeId: UUID,
  },
};
/** GET templates with a resource id whose query crosses, and the keys that may cross. */
const QUERY_KEYS_WITH_ID: Readonly<Record<string, readonly string[]>> = {
  'commission-payouts/admin/sellers/:id/ledger': ['limit', 'cursor'],
  'catalog/admin/platform-imports/:id/report': ['kind'],
  'catalog/admin/categories/:id/impact': ['action', 'targetId'],
};
/** DELETE templates whose query crosses: the version seen and the closed reason code. */
const DELETE_QUERY_KEYS_WITH_ID: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  'commission-payouts/admin/sellers/:id/payout-terms': {
    expectedVersion: /^[0-9]{1,9}$/,
    reasonCode: /^(seller-request|risk-review|correction|policy)$/,
  },
};
const QUERY_VALUE_MAX = 512;
/** A longer value for a key that carries a list: 200 ids of 36 characters and 199 commas. */
const QUERY_VALUE_MAX_FOR: Readonly<Record<string, number>> = {
  'catalog/admin/products/export:ids': 7400,
  'catalog/admin/attributes:search': 120,
};

/** The allowed keys of the request's query, capped in length; everything else is dropped. */
function upstreamQuery(method: string, target: string, requestUrl: string): string {
  // The relay allows an id segment only when it is a UUID, so the template is the path with
  // each UUID segment named `:id`.
  const template = target
    .split('/')
    .map((part) => (UUID.test(part) ? ':id' : part))
    .join('/');
  const deleteKeys = method === 'DELETE' ? DELETE_QUERY_KEYS_WITH_ID[template] : undefined;
  const keys =
    method === 'GET'
      ? (QUERY_KEYS[target] ?? QUERY_KEYS_WITH_ID[template])
      : deleteKeys === undefined
        ? undefined
        : Object.keys(deleteKeys);
  if (keys === undefined) return '';
  const source = new URL(requestUrl).searchParams;
  const shapes = deleteKeys ?? QUERY_SHAPES[target] ?? QUERY_SHAPES[template];
  const kept = new URLSearchParams();
  for (const key of keys) {
    const value = source.get(key);
    if (
      value === null ||
      value.length > (QUERY_VALUE_MAX_FOR[`${target}:${key}`] ?? QUERY_VALUE_MAX)
    ) {
      continue;
    }
    if (shapes?.[key]?.test(value) !== false) kept.set(key, value);
  }
  const text = kept.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * The storefront page editor's routes (storefront): a page is named by its id or, while a system
 * page was never changed, by its key; a slot by its key; a module by its id. Each segment is
 * checked on its own, so no other path shape reaches the API. The navigation page has its own
 * routes and is not a page key here.
 */
const PAGE_KEYS = [
  'home',
  'offers',
  'express',
  'category',
  'search',
  'product',
  'sellers',
  'seller',
  'cart',
  'checkout',
  'order-confirmation',
  'account',
];
const PAGE_SEGMENTS: Readonly<Record<string, (value: string) => boolean>> = {
  ':page': (value) => UUID.test(value) || PAGE_KEYS.includes(value),
  ':slot': (value) => /^[a-z][a-z0-9-]{0,31}$/.test(value),
  ':placement': (value) => UUID.test(value),
};
const PAGE_ROUTES: Readonly<Record<string, readonly string[]>> = {
  // The page's settings, replaced as a whole (a draft change; publishing is another route).
  PUT: [
    'storefront/admin/pages/:page',
    // One module's settings and switch, and the order of a slot's modules.
    'storefront/admin/pages/:page/slots/:slot/modules/:placement',
    'storefront/admin/pages/:page/slots/:slot/order',
  ],
  // A module added to a slot.
  POST: ['storefront/admin/pages/:page/slots/:slot/modules'],
  // A module removed from a slot.
  DELETE: ['storefront/admin/pages/:page/slots/:slot/modules/:placement'],
};

/** A delivery zone code as the API takes it (promotions free-shipping threshold of one zone). */
const ZONE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

function isAllowed(method: string, path: readonly string[]): boolean {
  if (ALLOWED[method]?.has(path.join('/')) === true) return true;
  const pageRoute = (PAGE_ROUTES[method] ?? []).some((template) => {
    const parts = template.split('/');
    return (
      parts.length === path.length &&
      parts.every((part, index) => {
        const check = PAGE_SEGMENTS[part];
        return check === undefined ? part === path[index] : check(path[index] ?? '');
      })
    );
  });
  if (pageRoute) return true;
  // The free-delivery threshold of one zone (promotions): the code is not a UUID.
  if (
    method === 'PUT' &&
    path.length === 4 &&
    path[0] === 'promotions' &&
    path[1] === 'admin' &&
    path[2] === 'free-shipping' &&
    ZONE_CODE.test(path[3] ?? '')
  ) {
    return true;
  }
  return (ALLOWED_WITH_ID[method] ?? []).some((template) => {
    const parts = template.split('/');
    return (
      parts.length === path.length &&
      parts.every((part, index) =>
        part === ':id' ? UUID.test(path[index] ?? '') : part === path[index],
      )
    );
  });
}

/** Request headers that cross to the API. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  'cookie',
  'content-type',
  'accept',
  'origin',
  'sec-fetch-site',
  'x-csrf-token',
  // The API keeps only a coarse browser and system code of it on a new session (profile).
  'user-agent',
] as const;

/** Response headers that cross back to the browser (Set-Cookie is handled on its own). */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  // The product export (CSV or XLSX) and the import report CSV arrive as attachments with a file name the API made.
  'content-disposition',
] as const;

/** The API issues the correlation id and returns it in this header (ADR-0034 decision 3). */
const CORRELATION_HEADER = 'x-correlation-id';

/** One structured line per failed relay: ids and codes only, never a body, cookie or token. */
export type RelayLog = (line: Record<string, string | number>) => void;
const stdoutLog: RelayLog = (line) => console.log(JSON.stringify(line));

const MAX_BODY_BYTES = 16 * 1024;
/**
 * The import upload carries a file of at most 10 MiB as base64 (about 14 MB). The API accepts
 * 14500 kB for this one path and checks the real size itself; every other path keeps 16 KB.
 */
const UPLOAD_PATH = 'catalog/admin/platform-imports';
/** A blog post's draft: up to 200 blocks of plain text, so more than the usual cap, still under the API's 64 kB JSON limit (blog). */
const BLOG_DRAFT_PATH = /^blog\/admin\/posts\/[0-9a-f-]{36}\/draft$/i;
const MAX_BLOG_DRAFT_BYTES = 60 * 1024;
const MAX_UPLOAD_BODY_BYTES = 14_500 * 1024;
/**
 * A category image (categories C3c) is a picture of at most 4 MiB as base64 (about 5.6 MB). The API
 * accepts 5800 kB for this one route and checks the real size itself.
 */
const CATEGORY_IMPORT_PATH = /^catalog\/admin\/category-tree\/import\/(?:dry-run|apply)$/;
const CATEGORY_IMAGE_PATH = /^catalog\/admin\/categories\/[0-9a-f-]{36}\/image$/i;
const MAX_IMAGE_BODY_BYTES = 5_800 * 1024;
/**
 * A manufacturer certificate's document (certification) is a file of at most 10 MiB as base64
 * (about 14 MB). The API accepts 14500 kB for this one route and checks the real size itself.
 */
const CERT_DOCUMENT_PATH =
  /^certification\/admin\/product-certificates\/[0-9a-f-]{36}\/documents$/i;
/** A platform product photo upload (catalog, P1): the same base64 photo cap. */
const PRODUCT_IMAGE_PATH = /^catalog\/admin\/platform-products\/[0-9a-f-]{36}\/images$/i;

/** The body cap of a request: the larger upload caps on their own paths, 16 KB for the rest. */
function bodyCapOf(method: string, target: string): number {
  if (method === 'POST' && target === UPLOAD_PATH) return MAX_UPLOAD_BODY_BYTES;
  if (method === 'PUT' && BLOG_DRAFT_PATH.test(target)) return MAX_BLOG_DRAFT_BYTES;
  if (method === 'POST' && CATEGORY_IMPORT_PATH.test(target)) return MAX_UPLOAD_BODY_BYTES;
  if (method === 'PUT' && CATEGORY_IMAGE_PATH.test(target)) return MAX_IMAGE_BODY_BYTES;
  if (method === 'POST' && CERT_DOCUMENT_PATH.test(target)) return MAX_UPLOAD_BODY_BYTES;
  if (method === 'POST' && PRODUCT_IMAGE_PATH.test(target)) return MAX_IMAGE_BODY_BYTES;
  return MAX_BODY_BYTES;
}

/** Lower case, no trailing dot on the host name; the port stays. */
export function normaliseHost(raw: string | null): string | null {
  if (raw === null) return null;
  const host = raw.trim().toLowerCase();
  if (host === '') return null;
  return host.replace(/\.(?=$|:)/, '');
}

export function panelHostFor(config: PanelConfig, rawHost: string | null): PanelHost | undefined {
  const host = normaliseHost(rawHost);
  return host === null ? undefined : config.hosts.find((entry) => entry.host === host);
}

/**
 * Set on every answer of the relay itself. The panel's `proxy.ts` does not run for `/api/` (its
 * body buffer would cut a large upload), so the one header a file download needs, `nosniff`, is
 * set here: a CSV or workbook from the API is never read as another type.
 */
const withSafetyHeaders = (headers: Record<string, string>): Record<string, string> => ({
  ...headers,
  'x-content-type-options': 'nosniff',
});

const jsonError = (status: number, code: string): Response =>
  new Response(JSON.stringify({ statusCode: status, code }), {
    status,
    headers: withSafetyHeaders({
      'content-type': 'application/json',
      'cache-control': 'no-store',
    }),
  });

const notFound = (): Response =>
  new Response(null, {
    status: 404,
    headers: withSafetyHeaders({ 'cache-control': 'no-store' }),
  });

/**
 * Headers for a request to the API: the allowlist plus the Market of the host, and, when this
 * panel has a signing key, the signed client address (ADR-0037). The browser's own
 * `x-client-address` is never forwarded; the signer reads only `x-mp-client-address`, which
 * `server.mjs` sets, and throws `MissingClientAddressError` when it is absent.
 */
export function upstreamHeaders(
  request: Request,
  host: PanelHost,
  config: PanelConfig,
  nowMilliseconds: () => number = Date.now,
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('x-market-id', host.marketId);
  if (config.clientAddressKey !== null) {
    headers.set(
      CLIENT_ADDRESS_HEADER,
      signForRequest({
        key: config.clientAddressKey,
        marketId: host.marketId,
        headers: request.headers,
        nowSeconds: Math.floor(nowMilliseconds() / 1000),
      }),
    );
  }
  return headers;
}

/** The request body as text, or null once more than `limit` bytes have arrived. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

/**
 * Relays one browser request to the API. `fetchImpl` is injected for tests; the route handler
 * passes the global `fetch`.
 */
export async function relay(
  config: PanelConfig,
  request: Request,
  path: readonly string[],
  fetchImpl: typeof fetch = fetch,
  log: RelayLog = stdoutLog,
): Promise<Response> {
  const host = panelHostFor(config, request.headers.get('host'));
  if (host === undefined) return notFound();
  const target = path.join('/');
  if (!isAllowed(request.method, path)) return notFound();
  if (request.headers.has('authorization')) return jsonError(401, 'session.invalid');
  if (request.method !== 'GET') {
    // Unsafe method: same-origin only, whatever the API would do with a missing header.
    if (request.headers.get('sec-fetch-site') !== 'same-origin')
      return jsonError(403, 'request.csrf');
    if (request.headers.get('origin') !== host.origin) return jsonError(403, 'request.csrf');
  }
  // A cheap filter, not an authentication check: the large document body is read only for a
  // request that carries an admin session cookie, so a caller with no cookie at all cannot make
  // the relay buffer 14.5 MB. A forged cookie still passes here; the API checks the session.
  if (
    request.method === 'POST' &&
    CERT_DOCUMENT_PATH.test(target) &&
    !/(?:^|;\s*)__Host-session-admin-[^=;]*=/.test(request.headers.get('cookie') ?? '')
  ) {
    return jsonError(401, 'session.invalid');
  }
  const bodyCap = bodyCapOf(request.method, target);
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > bodyCap) return jsonError(413, 'request.too-large');
  let body: string | undefined;
  if (request.method !== 'GET') {
    // Read the stream with a hard cap, so a chunked body without Content-Length is refused too.
    const read = await readCapped(request, bodyCap);
    if (read === null) return jsonError(413, 'request.too-large');
    body = read;
  }
  let outgoing: Headers;
  try {
    outgoing = upstreamHeaders(request, host, config);
  } catch (error) {
    if (!(error instanceof MissingClientAddressError)) throw error;
    log({ msg: 'panel.relay.client-address-missing', method: request.method, path: target });
    return jsonError(503, 'access.unavailable');
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(
      `${config.apiBaseUrl}/${target}${upstreamQuery(request.method, target, request.url)}`,
      {
        method: request.method,
        headers: outgoing,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        cache: 'no-store',
      },
    );
  } catch {
    log({
      msg: 'panel.relay.upstream-unreachable',
      method: request.method,
      path: target,
      marketId: host.marketId,
    });
    return jsonError(503, 'access.unavailable');
  }
  if (upstream.status >= 400) {
    log({
      msg: 'panel.relay.error-answer',
      method: request.method,
      path: target,
      status: upstream.status,
      marketId: host.marketId,
      correlationId: upstream.headers.get(CORRELATION_HEADER) ?? '',
    });
  }
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // Session answers must never be cached; the API sets no-store itself, this is the default.
  headers.set('cache-control', upstream.headers.get('cache-control') ?? 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  for (const cookie of upstream.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(upstream.status === 204 ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers,
  });
}
