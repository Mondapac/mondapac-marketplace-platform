# catalog: implementation notes

## Review of catalogue structure edits (Admin Inbox > System requests)

Field edits of existing PLATFORM catalogue structure are reviewed in area `catalogue` (on by
default, risk medium; a Market can switch it off). The edits are category details
(`PATCH catalog/admin/categories/:id`), attribute definitions (`PUT catalog/admin/attributes/:id`)
and the attribute links of a category (`PUT catalog/admin/categories/:id/attribute-links`).

- Each takes an optional `note` (1 to 500 characters, required when the area is reviewed, so a
  save without one is a `validation.failed` on `note` and nothing is kept). Each answers
  `request: {id, number}`, or null when no request was opened (area off, or the edit changed
  nothing). The links route returns it at the top level next to `links`.
- Each admin read (category, attribute, attribute links) carries `review: {reviewed, risk}`, so the
  panel asks for a note only when it is needed.
- The request holds small plain values (see `application/catalogue-review.ts`). Category details
  are flattened per locale; an edit whose values exceed the request limits is refused with
  `too-large-for-review` where the area is reviewed.
- Reverters (`application/catalogue-reverters.ts`) are registered with system-requests and write
  through the same domain path as the edit. See `docs/modules/system-requests/notes.md` for the
  outcomes and the known limits.
- A revert runs the checks an edit has, because the rules change over time. The reverters have a
  `check` that System requests calls before the unit opens: the decider holds the edit key, the
  claim-text check passes on every text the revert would write (for an attribute that includes the
  switched-off values it keeps), the content filter and locale rules hold for a category, and the
  units and publish rules hold for an active attribute. A failure, or a check that cannot answer,
  is `not-permitted` and nothing is written. A revert that would clear `material` on a published
  attribute is refused by the domain (`changed-since`), and a revert reads at most the newest 200
  revisions of an attribute.
- Imports (the attribute file import) run through a variant of the edit use case with a recorder
  that never reviews, so a file import never needs a note.

## Structure changes in Admin Inbox > System requests (owner decision of 18 Nov 2026)

- Applied now and reviewed after: category create, move and reorder, and attribute create. The
  routes take `note` (a move falls back to its reason) and answer `request`. The reverters are in
  `application/catalogue-structure-reverters.ts` and write through the in-unit functions of
  `categories/category-write-core.ts` (`discardInUnit`, `hideInUnit`, `reorderInUnit`) and the
  restructure (`restructureInUnit`).
- Wait for another admin's approval: category discard, merge, archive and products move;
  attribute discard, merge, merge of values and archive (not of a `material` attribute, which has
  its own two-person request); feature-set create. Where the area is reviewed the route checks
  the action as it would before applying it, files the proposal in the same unit and answers
  HTTP 202 with only `{request}`; nothing changes. A second proposal of the same subject is 409
  `system-requests.already-pending` with `pendingNumber`. The appliers
  (`application/catalogue-appliers.ts`) compare the subject with `before`, then run the same
  in-unit function as the route (`discardInUnit`, `restructureInUnit`, `discardAttributeInUnit`,
  `writeArchive`, `writeMerge`, `mergeValuesInUnit`, `startProductsMoveInUnit`,
  `createFeatureSetInUnit`) as the approving admin, naming the request in the audit row.
- Each approval kind is registered with every key its route's use case declares (`routeKeys`
  in `catalog.module.ts`): a products move needs `catalog.category-tree.restructure` and
  `catalog.product.approve`. What a pre-unit `check` cleared (`ClearedByRequest`) is dropped by the
  next check of the request and is handed only to the same admin in the same Market, so a
  decision that failed never reuses an earlier check.
- The tree read, the attribute list and the feature-set list carry `review`, so the panel asks for
  the note: the create, reorder and discard dialogs of a category, the restructure and move
  products dialogs (the reason is the note), and the add, discard, archive, merge and merge values
  dialogs of an attribute. A 202 shows "Sent for approval (SR-n)" and leaves the item as it is.
  Where an action only files a request its dialog says "Send for approval", says that nothing
  changes until another admin approves it, and shows no "can't be undone" line or terminal banner.
  The panel has no feature-set create page yet.
- Not hooked: the category-tree import and the attribute file import (see the system-requests
  notes); they run unreviewed.

## Add product is the edit form in add mode (seller #991, admin #994)

One page, no wizard. The same form serves Add and Edit; Add differs only in what is not yet
known.

- **Route.** Seller `/products/new` renders `EditForm` with the `add` prop (blank product built
  by `blankProduct(options)`); admin `/catalog/products/new` renders `ProductAdd`, which reads
  the options client-side and gives `EditForm` the `creating` prop.
- **Nothing is created until the first Save draft.** Opening the page, typing and leaving writes
  nothing. Publish (admin) and Submit for review (seller) are inactive until the product exists.
- **Save sequence (`createAndSave`).** `POST` create (seller: type, condition, SKU; admin: type
  only), then `PUT .../draft` with the page content and the `variantIds` returned by the create,
  then `router.replace` to the edit URL. Before leaving, `flushSync(() => setDirty(false))`
  releases the unsaved-changes guard so it does not prompt. A busy ref (not state) blocks a
  double submit. A 401 at either call goes to `/session-ended`. Once the create has succeeded,
  a failed or refused draft save still moves to the edit page and is told there (seller: toast;
  admin: `?saved=failed|refused`, read by `startProblemOf`), because for the seller a second Save draft would
  find the SKU taken (the admin create has no SKU). A failed create stays on the page with its problem shown.
- **Reads before the first save** come from the options endpoints, not a product read:
  `GET catalog/seller/products/options` and `GET catalog/admin/platform-products/options` (use cases
  `OwnProductOptions`, `PlatformProductOptions`): product types, locales, tax categories,
  categories (seller also conditions and `sellerCanCreateProduct`; the seller's product types are
  filtered to the types that seller may sell). A failed category read
  degrades to an empty list; the other answers stay usable.
- **Loading and guards.** The seller page loads the options server-side; when
  `sellerCanCreateProduct` is false it shows `catalog.create.closed` instead of the form. The
  admin page loads them client-side with loading, failed and retry states, and shows a no-access
  message (with a back link) when the session lacks the edit permission.
- **Seller and admin differ in one card.** The seller gets a "Your offer" card (type,
  condition, SKU; all required, checked before the call). The admin picks the product type in
  the Organisation card; a missing type is reported at the top and focuses the field.
- **DOM order equals visual order.** The two-column layout is an explicit `lg:` grid with
  `col-start`/`row-start`/`row-span`; no `order-*` classes, so tab and screen-reader order match
  what is seen. Add a card by giving it an explicit cell, not by reordering.

## Brand archive reason

`POST catalog/admin/brands/:id/archive` takes an optional `reason` next to `version` (trimmed, at
most 500 characters, no control characters or line breaks; empty or null means none; anything else
is `validation.failed` on `reason`). It is used when an admin turns a seller's proposal down or
retires a live brand. The text is stored on the brand (`catalog.brands.archive_reason`, CHECK:
only on an archived row) for the proposing seller's notice; the audit row `catalog.brand.archived`
records only `reasonGiven` (audit rows and events carry no text, ADR-0009 decision 6). No decision
reads it; a merge never sets it. It is not in the brand answers yet: the notice slice reads it.
