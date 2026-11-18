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

## Add product is the edit form in add mode (seller #991, admin #994)

One page, no wizard. The same form serves Add and Edit; Add differs only in what is not yet
known.

- **Route.** Seller `/products/new` renders `EditForm` with the `add` prop (blank product built
  by `blankProduct(options)`); admin `/catalog/products/new` renders `ProductAdd`, which reads
  the options client-side and gives `EditForm` the `creating` prop.
- **Nothing is created until the first Save draft.** Opening the page, typing and leaving writes
  nothing. Publish and Submit are inactive while adding.
- **Save sequence (`createAndSave`).** `POST` create (seller: type, condition, SKU; admin: type
  only), then `PUT .../draft` with the page content and the `variantIds` returned by the create,
  then `router.replace` to the edit URL. Before leaving, `flushSync(() => setDirty(false))`
  releases the unsaved-changes guard so it does not prompt. A busy ref (not state) blocks a
  double submit. A 401 at either call goes to `/session-ended`. Once the create has succeeded,
  a failed or refused draft save still moves to the edit page and is told there (seller: toast;
  admin: `?saved=failed|refused`, read by `startProblemOf`), because a second Save draft would
  find the SKU taken. A failed create stays on the page with its problem shown.
- **Reads before the first save** come from the options endpoints, not a product read:
  `GET catalog/seller/products/options` and `GET catalog/platform/products/options` (use cases
  `OwnProductOptions`, `PlatformProductOptions`): product types, locales, tax categories,
  categories (seller also conditions and `sellerCanCreateProduct`). A failed category read
  degrades to an empty list; the other answers stay usable.
- **Seller and admin differ in one card.** The seller gets a "Your offer" card (type,
  condition, SKU; all required, checked before the call). The admin picks the product type in
  the Organisation card; a missing type is reported at the top and focuses the field.
- **DOM order equals visual order.** The two-column layout is an explicit `lg:` grid with
  `col-start`/`row-start`/`row-span`; no `order-*` classes, so tab and screen-reader order match
  what is seen. Add a card by giving it an explicit cell, not by reordering.
