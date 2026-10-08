# cart: flows and screens (G2 UX specification)

| | |
|---|---|
| Author | Reza (ui-ux-designer), 2026-10-08 |
| Status | **Draft for review.** This is the UI condition of the combined gate (design part approved with conditions 2026-10-07: "no UI slice before Reza's `ux.md` and the Figma-first design-system update", condition 5; and Reza checks the reason codes of DD 3.2 before slice 1's API is frozen, condition 4: done in 3.2 and 7.3). Not approved until section 9 is filled |
| Module | `cart`, tier B, Phase 4. Domain part of the combined gate approved by the owner on 2026-10-07 |
| Reviewers asked | Jafar (product-designer), Mohammad (software-architect: the API needs in 7.3), Hassan (security-tester: 7.4), Hadi (product-owner: 7.2), Ali (cto) |
| Used for | Brief section 12 (filled in section 4 here), the Figma work (ADR-0017) and the buyer UI slices (8.2) |

**Ground truth.** `docs/modules/cart/brief.md` (sections 3 to 5, 7, 10, 12); `docs/design/domain/cart.md` ("DD", sections 2 to 7, 13);
`/mnt/project-files/phase-4/design/owner-answers.md` (2026-10-07 12:15: the owner accepted the 50-line limit, no exact stock number in the cart,
and the guest-cookie protections); `docs/modules/sellers/ux.md` ("SL-UX": section 3.1a is the source of the two buyer minimum-order messages, copied
verbatim in section 5); `docs/modules/identity/ux.md` ("ID-UX": customer sign-in and sign-up are its "Cus" variants of A1 to A6); `docs/modules/catalog/ux.md`
("CAT-UX" 3.5: what the storefront must follow) and `docs/modules/certification/ux.md` ("CUX" 3.8: `CertChip`); `docs/modules/inventory/brief.md` and
`docs/modules/pricing/brief.md` and their designs (what the cart displays: "only N left", GST-inclusive effective price, special price, "no valid price");
`docs/design/panels/information-architecture.md` ("IA"); `docs/design/figma/README.md` (library 1.8.3 built) and `docs/design/tokens/`;
ADR-0017 (Figma first), ADR-0022 (may-sell), ADR-0025 (batch reads are advisory).

**Not verified.** The Figma file was not opened; the library inventory comes from its README (built through 1.8.3), the plugin's `icons.json` (68 icons)
and the planned releases of the other UX documents, none of which is built beyond what the README lists. Values that live in Market configuration appear
as `{names}`; AU values are examples only. **There is no buyer-facing design direction yet** (no storefront IA, shell or research): everything the cart
needs from a storefront shell is written as an assumption in 7.1 and marked "assumed" where it is used. No research with real buyers exists; the layout
and the order of elements are provisional ("For Jafar", 7.2).

**IDs.** Continue SL-UX: S = seller-panel screen, P = admin-panel screen, C = card, D = dialog, E = email, F = flow. **`cart` has no seller-panel,
admin-panel, card or email design**, so its first free numbers there are S8, P5, C2 and E25 (E24 is the unbuilt "area opened" proposal of SL-UX 1.2) and none is
used. It uses **D11** (first free dialog number) and **F22** (first free flow number; SL-UX ends at F21). **B = buyer storefront screen.** ID-UX already
uses B1 to B5 for shared panel screens (members, roles, account security, no access); cart's buyer screens continue that sequence at **B6**, and the
Panel column of 1.1 says "Buyer" so the two uses cannot be mistaken (7.2 item 13 asks Jafar whether the buyer screens should get their own prefix). "AC n" is
the n-th acceptance criterion of brief section 10, counted from 1 in the order written (13 in all). Codes are the API codes of DD 3.2 and 5; the UI maps
each to a translation key and never shows server text (INTL-11).

## 1. Scope and inventory

Phase 4 UI for `cart`: **four buyer screens (B6 to B9) and one dialog (D11)**, seven flows (F22 to F28; F28 covers changes under the customer), no email.
The storefront shell, the product page and the sign-in screens are not this module's: cart specifies what it puts into them. Nothing in cart is a seller
or admin screen: the one seller-facing cart setting (the optional minimum order) is SL-UX S7 card "Settings", 3.1a, already specified.

### 1.1 Screens
| ID | Name | Panel | DD slice | AC | Priority | Note |
|---|---|---|---|---|---|---|
| B6 | Cart page (`/cart`, assumed route) | Buyer | 1, 2, 3, 4, 5 | 1 to 9, 11 to 13 | P0 | Grouped by seller; line states; quantity; remove and undo; minimum order; summary; guest sign-in card; hand-off to checkout |
| B7 | Add to cart (a control, not a page) | Buyer | 1, 3 | 1, 6, 11, 13 | P0 | Lives on the product page and in its Offer list (Phase 6 pages); cart owns the control, its states and its words |
| B8 | Cart button with count (header) | Buyer | 1 | 1 | P0 | Icon button, count, announcement; opens D11; the header around it is the storefront's (7.1) |
| B9 | After sign-in: adding your earlier cart | Buyer | 3 | 8, 9 | P0 | A status region and a banner on the page the customer lands on, not a page of its own |
| D11 | Mini-cart (side panel, bottom sheet below 480 px) | Buyer | 2 | 1, 2, 5 | P0 | Read-only review of the cart; one primary action "View cart" |

CRT-04 "N other sellers" (P1) is not designed here: brief section 3 gives it to the storefront and the Offers page.

### 1.2 Emails
None. The brief has no reminder, abandoned-cart or merge email (section 3, out of scope), and a merge sends nothing (DD 6.5).

### 1.3 Not designed, and why
- **Save for later, saved carts, wish list, abandoned-cart reminders:** brief section 3 puts them out of scope. No "Save for later" control appears anywhere; it
  must not be added as a convenience.
- **Checkout itself** (address, delivery, payment, order summary with frozen prices): `ordering`, Phase 5. This document designs only the hand-off (F26, 3.1 B6).
- **Coupons (CRT-06), delivery choice (CRT-07), tax and final total:** other modules. The summary shows an items subtotal only.
- **"Empty the cart" and "Remove all unavailable":** not in the brief. Each is N removes; a convenience can be proposed later (7.2 item 8).
- **A cart for sellers or admins:** `cart` is for the customer population only (DD 5).
- **Storefront shell, product page, sign-in and sign-up screens:** Phase 6 and identity's "Cus" variants (7.1).
- **Seller-side cart reporting:** brief section 2 (none at launch).

### 1.4 Changes this spec makes to approved documents
None. It follows the brief and DD. Where the DD leaves a UI choice it is decided in 3.1.1 (a line without display data) and F28 (a guest write with an invalid cookie).

## 2. Flows

State codes are those of DD 3.2 (line reasons), DD 5 (answers: `cart.offer-not-purchasable`, `cart.line-not-found`, `cart.too-many-lines`, `cart.not-ready`,
`validation.failed`, `access.unauthenticated`, `access.denied`, `access.unavailable`, `request.throttled` with `retryAfterSeconds`, `request.csrf`,
`conflict.stale`, `conflict.retry`). Three answers can follow any step and are mapped once in 3.4: `request.throttled`, `access.unavailable` and a network failure. Names the
DD does not have are proposals for Mohammad (7.3).

### F22. Add to cart (B7; DD 6.1; slices 1 and 3; AC 1, 6, 11, 13)
| # | Step | Failure or branch: code and what the user sees |
|---|---|---|
| 1 | On the product page the customer chooses a size or option (Variant) and a quantity (default 1) and presses "Add to cart". The button shows `State=Loading` at the same width and the control is read-only; a second press while one request is in flight is ignored (the add increments, so it is not idempotent: DD 10) | Quantity not a whole number from 1 to the ceiling: local check, field error `cart.error.validation.quantity`, nothing sent. Guest or signed in makes no difference to the control; the guest or account use case is chosen by the session |
| 2 | Guest only: the first add creates the cart and sets the cookie. No consent screen, no notice. Viewing never creates a cart (DD 4) | Cookie refused by the browser: the add succeeds on the server, so after every guest add the panel reads the count (API needs 4); if it is 0, B7 shows `cart.add.error.cookies` and no "Added" status |
| 3 | The answer says the line and its resulting quantity. B7 shows a status line "Added to your cart." with a "View cart" link; the B8 count updates; nothing moves focus and no drawer opens | Quantity limited: success plus a notice. `clamped: 'market-ceiling'` "The most you can have of one item is {max}. We set the quantity to {max}."; `'only-left'` "Only {count} left. We set the quantity to {count}."; limited to what the line already holds: "You already have the most you can add." |
| 4 | Refused: `cart.offer-not-purchasable` with `details.reason` | `offer-unavailable` "This item is no longer available."; `seller-cannot-sell` "This seller isn't selling right now."; `no-valid-price` "The price isn't available right now."; `out-of-stock` "Out of stock."; `check-unavailable` "We can't check this item right now. Try again in a moment." (the keys are those of `line.reason.*`, 5). The control stays; "Add to cart" is disabled for `offer-unavailable`, `out-of-stock` and `seller-cannot-sell` until the page is reloaded (the reason is text beside the button, not a tooltip). `reduce-quantity` never comes from an add (the add limits instead, step 3) |
| 5 | Line limit: `cart.too-many-lines` | "Your cart is full. A cart can hold up to {max} different items." with "View cart". `{max}` is the Market line limit (AU 50) from the API (API needs 6) |
| 6 | `request.throttled` (guest creation 30 an hour per network, guest writes 120 per 15 minutes per network and 60 per cart, DD 4) | One text for all: "You're making changes too quickly. Try again in {seconds, plural, one {# second} other {# seconds}}." The seconds are computed once from `retryAfterSeconds` and not counted down aloud; the button is enabled again at that time |
| 7 | `conflict.stale` or `conflict.retry` (nothing was written) | The panel re-sends once without telling the customer; a second failure shows `cart.error.write` ("We couldn't update your cart. Try again.") |
| 8 | Network failure or timeout, outcome unknown | Not "Try again": the add may have happened. `cart.add.error.unknown` "We couldn't confirm this. Check your cart before you try again." with "View cart"; the count is re-read first |
| 9 | `access.unavailable` (limiter fails closed) | `cart.error.unavailable`; nothing was written |
| 10 | Signed-in customer whose session ended mid-add: `access.unauthenticated` | The add is not retried as a guest add (it would create a second, separate cart): "Your session ended. Sign in to continue." with "Sign in" (return URL: this page) |

### F23. See the cart and fix what blocks checkout (B6; DD 6.2; slices 2 and 4; AC 2 to 5, 7)
| # | Step | Failure or branch |
|---|---|---|
| 1 | The customer opens B6 (or D11). One request returns the whole view (DD 6.2: five facade calls, two rounds, whatever the number of lines). Skeleton groups while it loads; no page spinner | `cart.error.load` with "Try again". The B8 count and D11 are independent reads, so one failing leaves the others standing |
| 2 | Lines are grouped by seller. Each group shows "Sold by {seller}" and the subtotal of its buyable lines. Each line shows its state (3.2), unit price, line amount and any notices. The summary shows the items subtotal over buyable lines only, in the Market currency | A seller name that is missing: the group shows `cart.group.sold-by-unknown` and nothing else changes (DD 7.1 SC2) |
| 3 | A line whose price differs from the price when it was added shows the price-change notice (3.2.1). It does not block checkout and cannot be dismissed; it clears when the customer changes that line's quantity or removes and adds it again (DD 6.3; 7.2 item 4) | Price up: Attention. Price down: Info. Same words, with "went up" or "went down" |
| 4 | A seller group below its minimum shows `cart.group.below-minimum` (verbatim from SL-UX 3.1a) in the group; checkout is blocked for the whole cart, and the message names only that seller (AC 7) | `check-unavailable` for the group (verbatim from SL-UX 3.1a): checkout stays blocked and the copy never implies "no minimum". A seller with an explicit "none" shows nothing (AC 7) |
| 5 | A line that cannot be bought shows its reason (3.2). It is outside the subtotal and blocks checkout until fixed or removed. `reduce-quantity` is cleared by "Change to {count}" (one press, the same write as a quantity change) or by typing a number | Several blockers: the blockers banner at the top counts them ("3 items need your attention") and links to the first |
| 6 | When the last blocker goes, a status message says "You can check out now." and the summary button becomes active; when a blocker appears (after a re-read), it says how many | The status is polite and announced once per change of the count, not per line |
| 7 | B6 re-reads on load and when the window regains focus after it was hidden for 30 seconds or more; it never polls (the ID-UX F5 rule). A re-read keeps the scroll position and the focus | Re-read fails: the last view stays, with an Attention banner `cart.error.partial-stale`: "We couldn't refresh your cart. What you see may be out of date." and "Try again". Checkout stays possible, because `ordering` checks again |
| 8 | A facade failure inside a successful view: the affected lines are `check-unavailable` and the page says so once at the top (`cart.error.partial`: "We couldn't check some items just now. Checkout is paused until we can.") | Fail closed for buying, not for seeing (DD 6.2) |
| 9 | No cart, or an expired one (90 days signed in, 7 days guest): the page shows the empty state. It does not say why (7.2 item 6) | |

### F24. Change the quantity, remove, undo (B6; DD 6.1; slice 1; AC 6, 12, 13)
| # | Step | Failure or branch |
|---|---|---|
| 1 | The stepper has minus, a number field and plus. A press of minus or plus changes the shown number at once and sends one change 500 ms after the last press. Typing sends on Enter or when the field loses focus. While a write is pending the line shows "Updating…" and `aria-busy`; the other lines stay usable. Writes to one cart go one at a time in the order made (the cart has one version, so parallel writes would collide); a newer quantity for the same line replaces a waiting one | Minus at 1 is disabled; "Remove" is a separate text action. Typed 0, text or more than the ceiling: `cart.error.validation.quantity` ("Enter a whole number from 1 to {max}. To take it out, use Remove."), nothing sent, the typed text kept |
| 2 | The answer is the truth: the shown number becomes the stored one. If the server limited it, a notice on the line says why (`clamped`, as F22 step 3) | `only-left` appears here only when the status is LOW; above the threshold the limit is `ordering`'s at checkout (DD 3.2, AC 3) |
| 3 | A change that really changes the quantity clears the price-change notice (the view comes back without it). A no-op write does not | |
| 4 | Remove: no confirmation dialog. The line is replaced by an undo row: "{product} removed." with "Undo". It stays until the next change to the cart or until the page is left; it has no timer (no time limit on a control; WCAG 2.2.1). Focus moves to the undo row; the live region says "{product} removed from your cart." | `cart.line-not-found` (the line was already gone: another window, or a purge): "That item is no longer in your cart." and a re-read |
| 5 | Undo adds the same Offer, Variant and quantity again with the add use case. The result is a new line at the end of its group, and the price-change notice does not come back (the stored price is the current one) | The add can be refused or limited (the item went off sale, the seller stopped, stock fell): the undo row becomes `cart.line.undo.failed` ("We couldn't put {product} back. You can add it again from its page.") with a link to the product page unless the reason was `offer-unavailable`. If the customer already added the same item again, quantities add up (the add rule) |
| 6 | Unbuyable lines: for `offer-unavailable` the stepper is not shown (nothing to buy; only Remove). For every other reason the stepper stays, because a line can always be lowered (DD 6.1) | |
| 7 | Failure of a write: the line returns to its last known quantity and an inline error under that line says what happened (3.4). Never a toast alone | `conflict.stale`: re-read and `cart.error.stale` ("Your cart changed in another window. We've updated it. Check it and try again."); `request.throttled`; `access.unavailable`; network failure with unknown outcome: re-read before offering to try again |

### F25. A guest checks out: sign in or sign up, then the carts merge (B6, B9; DD 6.5; slice 3; AC 8, 9)
| # | Step | Failure or branch |
|---|---|---|
| 1 | A guest sees B6 as everyone does, but the summary card is the **guest card**: "Sign in to check out" (primary), "Create an account" (secondary), and one line: "You can keep adding items without an account. To pay, sign in or create an account. Your cart comes with you." There is no "Check out" button for a guest, so no screen ever shows a dead end (brief flow 4; DD 5: `get-checkout-lines` would answer `access.unauthenticated`) | A signed-in session that ended while the page was open: F22 step 10 |
| 2 | "Sign in" opens the customer sign-in (ID-UX A1, Cus variant) and "Create an account" the sign-up (A2, Cus), both with this page as the return URL. Typed credentials never travel between the two (ID-UX F2) | The sign-in screens, their errors and throttling are identity's |
| 3 | After a successful sign-in (A1) or after the email confirmation completes the sign-in (A4, ID-UX F1 step 4), the storefront calls the merge **before** it moves to the return URL. The landing page shows B9 as a status region: "Adding the items from your earlier cart…" (`role="status"`); the cart count and D11 are read after it ends | The merge never blocks sign-in: sign-in is complete whatever happens next |
| 4 | Outcome: **nothing to merge** (no cookie, expired, already merged: the answer is `ok` with nothing merged): no message, the page continues | |
| 5 | Outcome: **the account had no cart**: the guest cart simply became the account's. One Info banner on the landing page: "We added the items from your earlier cart." (dismissable, in memory and, when storage works, once per sign-in) | |
| 6 | Outcome: **the account had a cart**. Same Offer and Variant in both: one line with the summed quantity, limited to the ceiling and, when stock is low, to "only N left". The older "price at add" is kept, so a price-change notice can show on a merged line (the merge does not clear it, DD 6.3). Guest lines the account cart could not take because of the line limit were not added (the account's lines stay; guest lines are taken oldest first) | Banner text: the base line of step 5, then, when they apply, `cart.merge.clamped` ("{count} quantities were lowered to the most you can have.") and `cart.merge.not-added` ("{count} items weren't added because a cart can hold up to {max} different items."). Each lowered line also carries `cart.line.merged-clamped` ("Combined with your earlier cart and limited to {count}.") until the next change or reload (needs the line ids in the answer: API needs 5). The not-added guest lines are gone from the guest cart, so the message is the only record: it gives a count, not names, unless the answer carries display data (7.3 item 5) |
| 7 | Merge fails (`request.throttled`, `access.unavailable`, `conflict.retry`, network): the customer is signed in and the guest cart is still there (its cookie is cleared only after a merge answers). The landing page shows an Attention banner `cart.merge.error` ("We couldn't add your earlier cart just now.") with "Try again", which repeats the merge (it is idempotent, DD 6.5 step 5). The B8 count shows the account cart meanwhile | If the customer ignores it, the next sign-in in the same browser merges again while the 7 days last |
| 8 | The email link opened in **another browser** (common on phones: the mail app's browser): that browser has no guest cookie, so step 4 applies and nothing is merged; the earlier browser keeps its guest cart for up to 7 days and merges at the next sign-in there | Open point for Jafar and Hassan (7.2 item 5); no text tries to explain it |
| 9 | Sign-out returns the person to a guest with an empty guest cart. The page that was open does not keep showing the account cart (`Cache-Control: no-store` on every cart read, and the page re-reads when restored from the back-forward cache) | |

### F26. Minimum order, and the hand-off to checkout (B6; DD 6.4, 6.6; slices 4 and 5; AC 3, 7)
| # | Step | Failure or branch |
|---|---|---|
| 1 | The cart is **ready** when every line is buyable and no group is blocked. The view says so (API needs 1); the panel does not work it out. Ready: "Check out" is active | Not ready: "Check out" stays focusable but disabled (`aria-disabled`), with the reason as text beside it: "Fix {count} items first." and a link "Go to the first one". Activating it does nothing |
| 2 | The customer presses "Check out". The button shows `State=Loading` ("Checking your cart…") and the panel moves to the checkout's first screen, which belongs to `ordering` (Phase 5). The cart sends no line, price, seller or quantity in the URL or the client state: `ordering` reads the cart on the server (`getCheckoutLines`, DD 6.6) | |
| 3 | `ordering` answers `cart.not-ready` (the cart changed since the page was drawn, or a quantity is above what stock allows and only `ordering` can see it, DD 3.2) | `ordering` sends the customer back to B6; B6 re-reads and shows `cart.error.not-ready` ("Your cart changed. Check the items below, then try again.") at the top. The contract for the redirect and for the stock case is ordering's G2 (7.5) |
| 4 | A seller below its minimum: the customer adds more from that seller. There is no link on the group to that seller's shop page in this spec (the shop page is Phase 6 and the cart is not given its address, 7.3 item 8); the way back is "Continue shopping" and the product pages | Adding items and coming back re-reads and clears the message (AC 7: "افزودن کالا از همان فروشنده قفل را باز می‌کند") |
| 5 | A currency or price-basis mismatch inside a group reaches the customer only as `check-unavailable` for that group (DD 6.4); no text names the cause | |

### F27. Header button and mini-cart (B8, D11; slices 1 and 2)
| # | Step | Failure or branch |
|---|---|---|
| 1 | The header cart button shows the count (what it counts: 7.2 item 2) and is read on load and after every cart write made in this window. It makes no facade calls (API needs 4). It is never polled | Count unreadable: the button shows no number and its name is just "Cart" |
| 2 | Press, tap or Enter opens D11 and starts one view read. The dialog takes focus on its title, traps focus, closes on Esc, outside press or "Close"; focus returns to the button | Read fails: `cart.error.load` inside D11 with "Try again" |
| 3 | D11 shows the groups and lines in the compact layout (state notices one line each), the items subtotal and two actions: "View cart" (primary) and "Continue shopping" (closes the panel). No quantity edit, no remove, no "Check out": all blocking messages live in one place, B6 (7.2 item 7) | Empty: `cart.empty.*` with "Continue shopping" |
| 4 | On B6 itself the button is the current page (`aria-current="page"`) and does not open D11 | |

### F28. The cart changes under the customer (all screens)
| # | Situation | What the UI does |
|---|---|---|
| 1 | Second window or tab changed or emptied the cart | The next write answers `conflict.stale` or `cart.line-not-found`: re-read, then the error text of F24 step 7. On focus, F23 step 7 refreshes the view |
| 2 | A guest write with a cookie that is no longer valid (expired, merged, planted): the add creates a new cart; a change or remove answers `cart.line-not-found` | The add works silently. The change or remove shows "That item is no longer in your cart." and a re-read that shows what is there. No text says the cookie was invalid (DD 4: the probe learns nothing) |
| 3 | Signed-in session ended | F22 step 10. The cart page for an account cart cannot be shown without a session |
| 4 | `request.csrf` or 415 on a write | A generic `cart.error.write`; a reload fixes a stale form. Not a sign-in prompt |
| 5 | Offline | `cart.error.write` or `cart.error.load` with "Try again"; the unconfirmed-outcome rule of F22 step 8 applies to adds and undo |

## 3. Screen specifications

### 3.0 Rules for every screen
1. **Shell (assumed, 7.1).** B6 sits in the storefront shell's content area; the panel `Sidebar`, `Topbar` and `AppShell` are not used. The Figma frames
   put a labelled placeholder header ("Storefront header, Phase 6") above the content so the frames are readable; it is not a library component and does
   not pre-empt the storefront design. B7 and B8 are specified as parts of someone else's page.
2. **Mobile first.** Frames at 360, 760 and 1280. One column below 1024 px; from 1024 px the groups take the main column and the summary a side column that stays in view. Below 760 px the
   summary is a sticky bottom bar (items subtotal and the primary button) and hides while a text field has focus (soft keyboard, as the IA bottom bar does); the full summary card follows
   the groups. Touch density on phones and tablets: controls 48 px; stepper buttons and "Remove" at least 44 px.
3. **Money.** Every amount comes from the API as `Money` and is formatted with `Intl.NumberFormat(locale, { style: "currency", currency })` using the
   Market currency (never a hard-coded symbol or "AUD"). **The panel does no money arithmetic**: unit price, line amount, group subtotal, cart subtotal,
   the minimum and "remaining" arrive ready (API needs 1). Sellers' wording `{priceBasis}` (a Market key, for example "including GST") follows the minimum
   and the page states the convention once: `cart.price-basis`. An amount is never split from its currency.
4. **Freshness and storage.** Every cart read and write is `Cache-Control: no-store`. The panel keeps cart data in memory only and does not write it to
   `localStorage`, `sessionStorage`, IndexedDB or a service-worker cache. The only per-viewer convenience that may use `sessionStorage` (inside try/catch,
   page correct without it) is the merge banner of B9, which holds counts and no names. On `pageshow` with `persisted`, B6, B8 and D11 re-read.
5. **Never, on any screen:** an exact stock number (the only number is `onlyLeft`, and only when the status is LOW); a cause behind a reason (not "suspended",
   "deleted", "withdrawn", "held for review", "not approved"); a price that is pending review; a claim or certification word the cart wrote itself (the
   chip is the `CertChip` from badge data and nothing else; where no badge data arrives there is no chip, no placeholder and no gap); the word "verified";
   a line, cart, Offer or seller id in a URL, title, visible text or telemetry; the guest token or cookie anywhere; a server message string; "Total" or
   "Pay" before checkout; shipping or tax amounts; "Save for later".
6. **A reason is text.** Every state is an icon plus words (brief section 9). Dimming is not a state: a line that cannot be bought keeps full-contrast text
   on `bg/subtle` and carries its notice.
7. **Plain text.** Product names, variant labels and seller names are data written by people: displayed as typed with `dir="auto"`, no HTML, no links
   built from them. Images use the product name as `alt`; a missing image shows the product-type icon, never a broken image.
8. **Async changes** are announced through two page-level live regions: a polite `role="status"` (quantity updated, item removed, cart ready or not,
   merge result, added to cart) and an assertive `role="alert"` used only for an error that stops what the person just did. Details in section 6.
9. **Dates and times.** The only time on these screens is the end of a special price (3.1, B6 line), shown in the seller's zone, named, when the API
   supplies the zone (7.3 item 7); otherwise it is left out.
10. **Permissions.** There are none to check in the UI. A person who is not signed in sees the guest variants; the panel never infers what a session may do.

### 3.1 Buyer screens
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **B6 Cart page.** See, fix and leave for checkout | Page title (H1) "Your cart" and the count line. `cart.price-basis` note. B9 banner when present. Cart-level banners: partial check (F23 step 8), stale refresh failure, not-ready return (F26 step 3), session ended. **Blockers banner** (Attention `InfoBanner`) when something blocks checkout: "{count} items need your attention" with links to each. Then one **`SellerGroup`** per seller (order: the order of the first line added, oldest first, which the API returns; nothing re-sorts as the customer edits): header "Sold by {seller}" and the subtotal of buyable lines; the group message slot; the `CartLine`s. Then the **summary** (`CartSummary`): "Items subtotal {amount}" over buyable lines, the shipping line (7.2 item 9), then the button (signed in) or the guest card (F25). "Continue shopping" link after the summary. One `CartLine`: image, product name (a link to the product page, except `offer-unavailable`), variant label, `CertChip` Compact per tag with badge data (a button that opens `CertDetail`), unit price ("{amount} each"; a special price shows "Special price" and "Regular price {amount}", text not strikethrough alone), the stepper and "Remove", the line amount, then notices (state, price change, "Only {count} left", merged-clamped). Every line has the hidden label "Sold by {seller}" (7.2 item 3) | Stepper and Remove (F24). "Change to {count}" on `reduce-quantity`. "Check out" (F26) or "Sign in to check out" and "Create an account" (F25). "Try again" on errors. Nothing else is editable | **Loading:** skeleton `SellerGroup`s (two groups of two lines). **Empty:** `EmptyState` (3.4). **Default**, **ready**, **blocked** (count), **guest**, **just merged** (B9), **partial check** (some lines `check-unavailable`), **refresh failed** (last view stays), **session ended** (account cart hidden, sign-in prompt), **error** (no cart data). Line states: 3.2. Group states: ok, below-minimum, check-unavailable, no buyable line. Write states: updating, undo row, write error | Exact stock; why a line is unbuyable beyond 3.2; the seller's minimum when the group has no buyable line; a subtotal that includes an unbuyable line; shipping or tax figures; "Total"; ids |
| **B7 Add to cart.** Put an item in the cart from the product page or its Offer list | Variant choice (the product page's own control) and the **`QuantityStepper`** (default 1), then the "Add to cart" `Button`. Under it one status line (polite). Same control in a compact form in an Offer row, where each Offer is a seller's listing: the seller name sits in the row's heading (STO-03), so the cart's "Sold by" is the page's | Quantity whole number 1 to the ceiling (the stepper's `max` is the ceiling from the API; the page never says "99" itself). One request at a time. F22 | **Default**; **adding** (Loading); **added** (status + "View cart"); **limited** (notice); **refused** per reason (button disabled for the three permanent reasons, text beside it); **cart full**; **throttled**; **unconfirmed**; **cookies refused** (guest) | Stock numbers other than `onlyLeft` (the product page shows the status; this control shows `onlyLeft` only inside the limited notice); the price in the button; "Buy now" |
| **B8 Cart button.** Always-visible way to the cart | `IconButton` with `shopping-cart` and a `CountBadge`. Accessible name "Cart, {count, plural, one {# item} other {# items}}" ("Cart, empty" at 0). Count above 99 reads "99+" visually and in full to a screen reader | Opens D11 (F27). On B6: the current page | **Default**, **count**, **no count** (unreadable), **current page**, **updated** (announced once per change, polite: "Cart updated: {count} in your cart.") | The amount; names of items |
| **B9 After sign-in: adding your earlier cart.** Explain what the merge did | A status region on the landing page while the merge runs, then an `InfoBanner` (Info; Attention on failure) with the outcome lines of F25 steps 5 to 7. Dismissable with a close button named "Dismiss message" | "Try again" on failure. Nothing else | **Working** (`role="status"`), **done**, **done with limits**, **failed** (retry), **nothing to merge** (nothing shown) | Counts of items the customer cannot act on; names of removed items unless the API supplies display data |
| **D11 Mini-cart** (`Dialog` Layout=Side) | Title "Your cart" with the count; the groups and lines in the compact layout (image, name, variant, quantity "× {count}", line amount, one notice line); items subtotal; "View cart" (primary), "Continue shopping"; "Close" | Read-only. Tab order: title, the lines' product links, "View cart", "Continue shopping", "Close" | **Loading** (skeleton), **default**, **blocked** (one line at the top: "Some items need your attention. View your cart to fix them."), **empty**, **error** | Stepper, Remove, "Check out", the guest card (a guest sees the same panel; B6 asks them to sign in) |

#### 3.1.1 Line state, group state and the price block (shared by B6 and D11)
The line state is the API's (DD 3.2); the panel shows one reason at most. Precedence is the DD's and is not reimplemented: the panel renders what the line carries.

| Reason (DD 3.2) | In the subtotal | Treatment of the line | Text (key `cart.line.reason.*`) | Action |
|---|---|---|---|---|
| (buyable) | Yes | Full | none; if the status is LOW: "Only {count} left." (Info) | Stepper, Remove |
| `offer-unavailable` | No | Name and image if the answer carried them, otherwise the placeholder name `cart.line.unavailable-name` ("Item no longer available") and the `package` icon; no link, no price, no stepper. Critical notice | "This item is no longer available." | Remove |
| `seller-cannot-sell` | No | Name, image and variant stay; no price. Critical notice | "{seller} isn't selling right now." ("This seller isn't selling right now." when no name) | Stepper (lower), Remove |
| `no-valid-price` | No | No price shown. Attention notice | "The price isn't available right now." | Stepper, Remove |
| `out-of-stock` | No | Price shown as last read is **not** shown (nothing to buy). Critical notice | "Out of stock." | Stepper, Remove |
| `reduce-quantity` | No (counted when fixed) | Price shown. Attention notice | "Only {count} left. Reduce the quantity to check out." | "Change to {count}", stepper, Remove |
| `check-unavailable` | No | Name and image stay. Attention notice | "We can't check this item right now. Try again in a moment." | Stepper, Remove; a "Try again" on the page-level banner re-reads |

A line with a reason is outside the group subtotal and the cart subtotal and blocks checkout. The sellers' wording for the buyer **minimum order** is
shown in the group, once per group, and only for a group with at least one buyable line:

| Group state | Message (verbatim from SL-UX 3.1a; keys in section 5) | Tone |
|---|---|---|
| ok, or an explicit "none" | none | none |
| `below-minimum` | "{seller} requires at least {minimum} per order. Add {remaining} more to check out." The Market's convention, when known, is appended to `{minimum}` as "({priceBasis})" | Attention, `alert-triangle` |
| `check-unavailable` | "We can't check the minimum order for {seller} right now. Try again in a moment." | Attention, `alert-circle` |
| no buyable line | none; the subtotal reads "No items to buy" | Neutral |

**Price block.** Unit price and, when the API says the basis is `special`, the words "Special price" plus "Regular price {amount}"; the end of the special
("Special price until {dateTime}") only when the API supplies the seller's zone. **Price-change notice** (a line whose current price differs from the price
at add): "The price went up from {previous} to {current} since you added this." (Attention, `arrow-up`) or "...went down..." (Info, `arrow-down`). A price
pending review is never shown: the line shows the previous effective price with no notice, because the API only answers the effective price.

### 3.2 Reason codes checked (DD condition 4)
DD 3.2 is enough for the UI with notes for Mohammad (7.3 items 1 and 6): `onlyLeft` is needed on every LOW line, not only on `reduce-quantity`; `offer-unavailable` carries no cause and the UI adds none;
a line `check-unavailable` and a group `check-unavailable` are different facts with different keys; `cart.not-ready` must carry the codes the view uses; `cart.too-many-lines` needs `{max}`.

### 3.3 Dialogs
- **D11 Mini-cart.** Rules of ID-UX 3.3 apply (title names the object; focus trap and return; Esc closes; background inert). Layout=Side at 480 px and
  above (inline-end edge; in RTL the start edge of the reading direction mirrors, so it opens on the left), Layout=Sheet below 480 px (the existing `Dialog`
  sheet behaviour). Max width `size/dialog-md`. It opens only by the customer's action and never on its own after an add (F22 step 3).
- **No other dialog.** Remove is undoable (F24 step 4), so there is no confirmation. The guest sign-in prompt is a card in B6, not a dialog, so it can be
  read, tabbed to and returned to without a trap. The decision is recorded in 7.2 item 7.

### 3.4 Empty, loading, error and locked, in one place
| Surface | Empty | Loading | Error | Locked or read-only |
|---|---|---|---|---|
| B6 | `EmptyState` with the `shopping-cart` icon: "Your cart is empty" / "Items you add will appear here." / "Continue shopping" | Skeleton groups; the H1 and the count line already show; no spinner | `cart.error.load` ("We couldn't load your cart. Try again.") with "Try again", replacing the groups; the summary is absent | A group or line being written: `aria-busy`, controls of that line disabled, the rest usable |
| D11 | "Your cart is empty" / "Continue shopping" | Skeleton lines | The same error line inside the panel | Read-only always |
| B7 | n/a | `State=Loading` on the button | Per F22: reason text under the control | Disabled with the reason beside it for permanent reasons |
| B8 | "Cart, empty" (no number) | n/a | No number | n/a |
| B9 | Nothing shown | "Adding the items from your earlier cart…" | `cart.merge.error` with "Try again" | n/a |
| Throttled | n/a | n/a | `cart.error.throttled` under the control that was used | The control returns after the wait |
| Unavailable (limiter or service) | n/a | n/a | `cart.error.unavailable` | The action stays available; nothing was written |

## 4. Design-system impact (fills brief section 12)

"Existing" is `docs/design/figma/README.md` section 5 (library built through **1.8.3**), `icons.json` (68 icons) and the other UX documents' planned components (`CertChip`, `CertDetail`:
planned, not built; cart needs only `CertChip`, and only when badge data exists). Their planned release numbers (SL-UX 1.3.0 and 1.4.0, CUX 1.5.0 and 1.6.0, CAT-UX 1.7.0 and 1.8.0) collide with
releases the README (section 9) already built, so cart's release is named by content, **"Cart (buyer)"**, a MINOR, and takes **the next free number when published** (1.9.0 if nothing ships first).
It needs only what is built: `Dialog`, `Toast`, `EmptyState`, `InfoBanner`, `IconButton`, `CountBadge`, `Button`, `Input`, `ProductThumb`.

| Screen element | Existing component or template | Change needed in Figma first | Release |
|---|---|---|---|
| Quantity control (B6 line, B7) | `Input`, `IconButton` | New **`QuantityStepper`**: minus, number field, plus; States Default, Focus, Disabled, Updating, Error; Size Regular, Compact; BOOLEAN `Show remove`; 44 px targets in Touch; locale digits. Two places | MINOR |
| Cart line (B6, D11) | `ProductThumb`, `CertChip`, `Button` (Link), `InfoBanner` | New **`CartLine`**: Layout Full, Compact; slots Image, Name, Variant, Chips, Price block, Quantity, Line amount, Notices (0 to 2); States Default, Updating, Unbuyable (`Reason`), Removed (undo row), Error, Loading | MINOR |
| Seller group (B6, D11) | surface of the library, `InfoBanner` | New **`SellerGroup`**: header ("Sold by", subtotal), message slot, line slot; Layout Full, Compact; States Default, Below minimum, Cannot check, No buyable line, Loading | MINOR |
| Summary (B6, D11 footer) | `Button`, `InfoBanner` | New **`CartSummary`**: Layout Card, Sticky (below 760 px), Footer; Mode Ready, Blocked (reason and link), Guest (sign-in card), Loading | MINOR |
| Inline notices (price change, reason, minimum order) | `InfoBanner` | New property **Size** (Regular, Compact): one line, start icon, optional text link. Used inside `CartLine` and `SellerGroup` | MINOR |
| Larger product image | `ProductThumb` (`size/thumb` 28 px) | New **Size** (Regular, Large) and token **`size/thumb-lg`** (value on the existing scale, same in both densities) | MINOR |
| Mini-cart (D11) | `Dialog` (Sheet below 480 px) | New **Layout** value Side (full height, inline-end edge, `size/dialog-md` max width) | MINOR |
| Cart button (B8), empty cart, messages under controls, guest card, chip on a line | `IconButton` + `CountBadge`, `EmptyState`, `Field` helper text, `Button`, `CertChip` | None. Frames for each B8 state. Messages are inline status lines, not toasts. The guest card is `CartSummary` Mode Guest | n/a |
| Icons | 68 | Add **1**: `shopping-cart`. Reused: `trash`, `plus`, `minus`, `undo`, `package`, `alert-circle`, `alert-triangle`, `info`, `arrow-up`, `arrow-down`, `chevron-right`, `x` | MINOR |
| Templates | Seller, Admin, Auth only | New section **Templates · Storefront**: `Storefront · Cart` (B6) and `Storefront · Cart controls` (B7, B8, D11, B9), each with a labelled placeholder header frame that is **not** a library component (7.1) | MINOR |

- **New components (4)**, each on at least two surfaces as the update procedure requires. **Changed (3):** `InfoBanner`, `ProductThumb`, `Dialog`. **New token (1):** `size/thumb-lg`. **New icon (1).** **New templates (2).**
  Nothing is renamed or removed, so no MAJOR. Light and dark; Touch density for B6 to D11; the Audit plugin file must be clean (ADR-0017).
- The storefront shell (header, search, footer, content container) is not built here and no content-width token is invented (7.1).
- Brief section 12 is covered: cart page with seller group (B6), small drawer (D11), unbuyable line and "reduce quantity" and price change and minimum-order message (3.1.1), guest sign-in request
  (`CartSummary` Guest), the seller's minimum-order field (SL-UX 3.1a, specified), the "other sellers" list (CRT-04, deferred). Its two blanks: two templates; version "Cart (buyer)", next free MINOR.

## 5. Copy

Keys are `cart.<surface>.<element>[.<variant>]`, kebab-case, ICU MessageFormat, en-AU spelling. Error keys are `cart.error.<code>`; an unknown code uses
`identity.error.unknown`. Values from Market configuration are keys the Market owns (`{priceBasis}`, currency). (L) marks text for legal review. The Persian text
is translated from these English keys in the i18n catalogue (the brief's own terms: سبد خرید, فروخته توسط, حداقل سفارش); nothing here is Persian-only.

**Words used everywhere:** cart; item; quantity; Sold by; subtotal (items only); check out; sign in; create an account; special price; regular price; minimum order. **Never:** basket, bag,
"buy now", "total", "verified", "deleted", "suspended", "held".

| Key (prefix `cart.`) | en-AU text |
|---|---|
| `page.title · page.count · price-basis` | Your cart · {count, plural, one {# item} other {# items}} · {priceBasis, select, none {} other {Prices are shown {priceBasis}.}} |
| `page.continue` | Continue shopping |
| `empty.title · .body` | Your cart is empty · Items you add will appear here. |
| `group.sold-by · .sold-by-unknown · .subtotal · .subtotal-none` | Sold by {seller} · Sold by another seller · Subtotal {amount} · No items to buy |
| `group.below-minimum` (SL-UX 3.1a "below-minimum", verbatim) | {seller} requires at least {minimum} per order. Add {remaining} more to check out. |
| `group.minimum-basis` | ({priceBasis}) (appended to `{minimum}` when the Market's convention is known) |
| `group.check-unavailable` (SL-UX 3.1a "check-unavailable", verbatim) | We can't check the minimum order for {seller} right now. Try again in a moment. |
| `line.sr-sold-by` (visually hidden, on every line) | Sold by {seller}. |
| `line.unit-price · .price-special · .price-regular · .special-until` | {amount} each · Special price · Regular price {amount} · Special price until {dateTime} |
| `line.amount-label` (hidden) | Line total: {amount} |
| `line.price-changed.up · .down` | The price went up from {previous} to {current} since you added this. · The price went down from {previous} to {current} since you added this. |
| `line.only-left` | Only {count} left. |
| `line.unavailable-name` | Item no longer available |
| `line.reason.offer-unavailable · .seller-cannot-sell · .seller-cannot-sell-unnamed` | This item is no longer available. · {seller} isn't selling right now. · This seller isn't selling right now. |
| `line.reason.no-valid-price · .out-of-stock` | The price isn't available right now. · Out of stock. |
| `line.reason.reduce-quantity · action.set-to-max` | Only {count} left. Reduce the quantity to check out. · Change to {count} |
| `line.reason.check-unavailable` | We can't check this item right now. Try again in a moment. |
| `line.quantity.label · .increase · .decrease` | Quantity for {product} · Add one more {product} · Take one {product} off |
| `line.action.remove · .remove-label` | Remove · Remove {product} from your cart |
| `line.updating · .updated (live)` | Updating… · Quantity for {product} is now {count}. |
| `line.removed · .removed-live · .undo · .undo-done · .undo-failed` | {product} removed. · {product} removed from your cart. · Undo · {product} is back in your cart. · We couldn't put {product} back. You can add it again from its page. |
| `line.clamped.market-ceiling · .only-left · .already` | The most you can have of one item is {max}. We set the quantity to {max}. · Only {count} left. We set the quantity to {count}. · You already have the most you can add. |
| `line.merged-clamped` | Combined with your earlier cart and limited to {count}. |
| `blockers.title · .link` | {count, plural, one {# item needs} other {# items need}} your attention · Go to {product} |
| `blockers.body` | You can't check out until they're fixed or removed. |
| `summary.title · .subtotal · .shipping (L, 7.2 item 9)` | Order summary · Items subtotal · Shipping is worked out at checkout. |
| `summary.checkout · .checking · .help.blocked · .help.go-first` | Check out · Checking your cart… · Fix {count, plural, one {# item} other {# items}} first. · Go to the first one |
| `summary.ready-live · .blocked-live` (live) | You can check out now. · {count, plural, one {# item needs} other {# items need}} your attention before you can check out. |
| `guest.body · .sign-in · .create` | You can keep adding items without an account. To pay, sign in or create an account. Your cart comes with you. · Sign in to check out · Create an account |
| `add.action · .adding · .done · .view` | Add to cart · Adding… · Added to your cart. · View cart |
| `add.error.too-many-lines` | Your cart is full. A cart can hold up to {max} different items. |
| `add.error.unknown · .cookies` | We couldn't confirm this. Check your cart before you try again. · Your browser is blocking cookies, so we can't keep a cart. Allow cookies for this site and try again. |
| `button.label · .label-empty · .announce` | Cart, {count, plural, one {# item} other {# items}} · Cart, empty · Cart updated: {count, plural, one {# item} other {# items}} in your cart. |
| `mini.title · .view · .continue · .close · .blocked` | Your cart · View cart · Continue shopping · Close cart · Some items need your attention. View your cart to fix them. |
| `merge.working · .done` | Adding the items from your earlier cart… · We added the items from your earlier cart. |
| `merge.clamped · .not-added` | {count, plural, one {# quantity was} other {# quantities were}} lowered to the most you can have. · {count, plural, one {# item wasn't} other {# items weren't}} added because a cart can hold up to {max} different items. |
| `merge.error · .retry · .dismiss` | We couldn't add your earlier cart just now. · Try again · Dismiss message |
| `error.load · .partial · .partial-stale` | We couldn't load your cart. Try again. · We couldn't check some items just now. Checkout is paused until we can. · We couldn't refresh your cart. What you see may be out of date. |
| `error.write · .stale · .line-not-found · .not-ready` | We couldn't update your cart. Try again. · Your cart changed in another window. We've updated it. Check it and try again. · That item is no longer in your cart. · Your cart changed. Check the items below, then try again. |
| `error.validation.quantity` | Enter a whole number from 1 to {max}. To take it out, use Remove. |
| `error.throttled · .unavailable · .session-ended` | You're making changes too quickly. Try again in {seconds, plural, one {# second} other {# seconds}}. · We couldn't process this just now. Try again in a moment. · Your session ended. Sign in to continue. |
| `common.try-again · .sign-in` | Try again · Sign in |

Notes on the table. The two minimum-order keys copy the text of SL-UX 3.1a word for word, including its rules (shipping excluded from the amount, `{priceBasis}` appended
when known, no message for an explicit "none", money formatted with `Intl` and the Market currency). `{remaining}` and `{minimum}` arrive from the API as `Money`. "Items
subtotal" is deliberate: it says the figure is not a total. The sentence "Shipping is worked out at checkout." is provisional until `ordering` and `shipping` fix what the
customer is told (7.2 item 9). The price-change sentences, "Special price", "Regular price" and the price-basis line are (L): consumer-law review of price comparisons and of
GST wording (AU; pricing Q6's tax-adviser confirmation is still pending).

## 6. Accessibility, responsiveness, RTL and locale

Gate: WCAG 2.2 AA (ID-UX 6; the brief: unbuyable, price change and minimum order are text, not only colour).
- **Live regions for async change.** B6, B7 and D11 each have one polite `role="status"` region, in the DOM from load and empty. It receives one message at a time and
  only on a real change: "Quantity for {product} is now {count}." after a write answers (not per key press); "{product} removed from your cart."; the readiness change
  ("You can check out now." / "{count} items need your attention..."), announced once per change of the count; the merge result (B9); "Added to your cart." (B7); the B8
  update. A new message replaces an unread one. One assertive `role="alert"` region carries only errors that stop an action (failed write, failed merge, ended session).
  A re-read the person did not ask for (focus return) uses the polite region only. Skeletons set `aria-busy` on the region and are not announced.
- **Focus.** Nothing moves focus by itself except: opening D11 (to its title; Esc and "Close" return it to B8); removing a line (to the undo row; after Undo to the restored
  line's stepper; if Undo fails, to the failure text); a link in the blockers banner (to that line's heading); a `cart.not-ready` return (to its banner); a failed keyboard write
  (to the line's error text). After B9 ends, focus stays where the page puts it (the H1).
- **Structure.** H1 "Your cart"; each `SellerGroup` is a `section` labelled by its H2 "Sold by {seller}"; lines are a list; the summary is a landmark labelled "Order summary"
  (`aside` from 1024 px). Below 760 px the sticky bar is the one "Check out" in the accessibility tree (the card after the list omits its button there). A line's accessible name is
  the product name, completed by the hidden "Sold by {seller}" and "Line total" texts.
- **Stepper.** Real `button`s named per product; a numeric field with a label; Up and Down change by one. The disabled minus at 1 stays focusable (`aria-disabled`, described by
  "Use Remove to take it out"). Disabled controls give a reason as text beside them (Check out, a permanent "Add to cart" refusal), linked by `aria-describedby`; never a tooltip alone.
- **Contrast and non-colour.** Text 4.5:1, control borders 3:1. Critical, Attention and Info notices differ by icon and words; "went up" and "went down" are words and arrows; a special
  price is words, not strikethrough alone. Forced-colors keeps icon and border. Under `prefers-reduced-motion` Updating is a static icon and text and D11 opens without a slide.
- **Targets and widths.** 48 px for primary controls, 44 px for stepper buttons, Remove and chips on phones; nothing under 24 px. Smallest width 320 px. Below 760 px a `CartLine`
  is a card (image and name; variant and chips; price block; stepper and Remove on one wrapping row; line amount and notices).
- **RTL.** Logical properties only. The stepper reads minus, number, plus in the reading direction; digits follow the locale; money uses `Intl`. `arrow-up` and `arrow-down` do not
  mirror; `chevron-right` does. Names use `dir="auto"`; each minimum-order sentence is one translated unit with `{seller}`, `{minimum}` and `{remaining}` isolated (`bdi`), so a Latin store
  name inside a Persian sentence keeps its order. D11 opens from the inline-end edge (left in RTL). Text may grow 40%: buttons wrap, never truncate.
- **Locale and Market.** Nothing is hard-coded to AU or AUD. Currency, exponent, price basis, ceiling and line limit come from the API; dates, numbers and plurals from the user's locale.
  The ZZ fixture (JPY, exponent 0, prices without tax, other ceiling and line limit) renders B6 and D11 with no code change: a Storybook or Playwright case per Market fixture for B6
  (groups, a below-minimum group, a price change), B7 (limited) and D11.
- **Guest privacy.** The cookie is `HttpOnly`; the page never reads it and shows no sign of it. A browser that blocks it is handled in B7 (F22 step 2).
- **Certification claims.** The cart writes none. A `CertChip` renders only from badge data (CUX 3.8); a tag the API left out leaves nothing, and nothing explains the gap.

## 7. Open points

### 7.1 Assumptions about the storefront shell (open until Phase 6 designs it)
There is no buyer-facing IA, shell, template or research, and `docs/design/panels/information-architecture.md` covers the two panels only. Cart needs these things from it and I
assumed them so B6 to D11 can be designed; each is an open point for Jafar and Hadi, and the Figma frames mark the placeholder with the label "Storefront, assumed".
| # | Assumed | If it changes |
|---|---|---|
| SA1 | A storefront header carries brand, search, an account menu and the cart button B8; footer and Market name as in ID-UX Auth | B8 moves; nothing else |
| SA2 | The cart page is a route of the storefront host, written here as `/cart`; sign-in and sign-up are the "Cus" variants of A1 and A2 on the same host with a return URL of the same host | Route names change; flows stay |
| SA3 | The storefront has a content container and a two-column layout from 1024 px; cart adds no token for it | The design track picks the container |
| SA4 | The storefront knows whether a customer session exists and the Market, and passes `signedIn` and the Market to the cart screens | Needed for the guest card |
| SA5 | Breakpoints 360, 760 and 1024 as in the panels; Touch density on phones and tablets; the library's tokens and components | A different storefront look would re-skin tokens, not structure |
| SA6 | The product page and its Offer list host B7 and show the product's stock status ("In stock", "Only N left", "Out of stock") with the inventory words | B7 would take its status words from that page |
| SA7 | The storefront reads the cart through the cart use cases only and caches nothing (3.0 rule 4) | Caching a cart view is a reviewed design (DD 2.2) |
| SA8 | **The storefront is Phase 6, and `ordering` is Phase 5.** If a customer is to reach checkout in Phase 5, a minimal storefront carrying B6 to D11 and a product page with B7 has to exist then | Question for Hadi and Jafar (7.2 item 1) |

### 7.2 For Jafar and Hadi (product and wording)
1. **Which storefront carries the cart in Phase 5** (SA8) and who designs the shell; until then no buyer UI slice can start (8.2).
2. **Header count.** Proposed: the **total quantity** of all lines (3 shirts and 2 jars = 5), "99+" above 99; the alternative is the number of lines. Cheap either way, no facade call
   (API needs 4). It includes unbuyable lines, because it cannot know them.
3. **"Sold by" on every line (CRT-03).** The group heading carries it visibly and each line carries it as hidden text. If Jafar wants it visible per line, it goes into the compact `CartLine`.
4. **Acknowledging a price change.** The notice cannot be dismissed and clears only when the quantity changes or the line is removed and added again (Q4 and the brief change log). A customer who
   accepts the new price has no control for it; an "OK" action needs a new write (API needs 7). Hadi decides.
5. **Merge when the confirmation link opens elsewhere** (F25 step 8): the earlier browser merges at its next sign-in within 7 days; no text explains it. Jafar and Hassan confirm.
6. **Telling the buyer about expiry.** An expired cart shows "Your cart is empty" without a reason, and a guest is not told that a guest cart lasts 7 days. Telling needs the retention values from the
   API. Recommended: not at launch.
7. **Mini-cart is read-only with no "Check out"; remove has no confirmation (Undo instead); the guest prompt is a card, not a dialog.** Jafar can overturn each.
8. **"Empty the cart" and "Remove all unavailable"** are not in the brief and not designed.
9. **Shipping line.** "Shipping is worked out at checkout." assumes `ordering` shows shipping. CRT-07 is P0 but `shipping` is Phase 6 and the brief gives Phase 5 one simple method (brief section 8). Hadi and
   ordering's G2 fix the sentence.
10. **Regular price beside a special price** is my reading of pricing's display rule. Legal (L) decides whether a comparison price is allowed and how it is worded.
11. **Wording that needs legal (L):** the price-change sentences, "Special price", "Regular price", the price-basis line (GST; the tax adviser's confirmation before Phase 5 is pending), the shipping
    sentence, and whether the strictly functional guest-cart cookie needs a notice.
12. **Page title** stays "Your cart" with no count (a count in the tab title changes on every edit).
13. **Prefix.** Cart's buyer screens are B6 to B9 and D11 so the sequence continues from ID-UX B5. If the buyer surface grows (storefront, product page, checkout), a separate prefix (for example BY) is
    cleaner; Jafar decides before the next buyer module.
14. **A link from a below-minimum group to that seller's shop page** needs the shop address in `sellerSummaries` and a Phase 6 route (API needs 8); not designed.
15. **Figma release number.** The numbers planned in SL-UX, CUX and CAT-UX collide with built releases; cart takes the next free MINOR when published (section 4). Renumbering the others is the design track's job.
16. **Persian.** English keys are the source; translations are made in the i18n catalogue. No research with Persian-reading buyers exists.

### 7.3 API needs (for Mohammad)
1. **The view answer** (`cart.view-cart` and guest): per group `sellerId`, display name (or absent), subtotal of buyable lines (`Money`), `minimumOrder` (none, `Money`, or "cannot check"), `remaining` (`Money`) for a
   `below-minimum` group; per line `lineId`, `offerId`, `variantId`, quantity, state `buyable` or the reason, `onlyLeft` for any LOW line, display data (product name, variant label, image key), badge data per tag,
   `unitPrice`, `regularPrice` and `basis`, line amount, `taxInclusive`, `priceChanged: { previous }`; cart-level `subtotal`, `checkout: { ready, blockers }`, and `limits: { maxLineQuantity, maxLines }`. The panel computes no
   amount and no state. **The Market's price-basis text key** arrives from Market configuration.
2. **Write answers.** Add, change and remove should return the updated line and the group and cart totals (or the whole view), so one click does not cost a second read of five facade calls. Otherwise the panel re-reads after
   each debounced write; say which.
3. **Add answer:** the resulting line quantity, `clamped` (`market-ceiling`, `only-left`, or "already at limit") and `onlyLeft` when it applies.
4. **A count endpoint** (safe method, no facade calls, no cart created, `no-store`) for B8 and for the guest cookie check after an add. It returns total quantity and line count, 0 for no cart.
5. **Merge answer:** counts; the `lineId`s limited by the ceiling or stock (account lines keep their ids); the guest lines not added with display data (product name, variant label) so the banner can name them, or only a count; the
   merge answer for "nothing to merge" is `ok`. Confirm the cookie is cleared only on an answered merge, not on `access.unavailable` or a throttle.
6. **Codes and details.** `cart.too-many-lines` and the quantity validation error carry `{max}` (ceiling or line limit); `cart.not-ready` carries the same line and group codes the view uses; `request.throttled` carries
   `retryAfterSeconds` for both guest creation and guest writes (one text covers both); retention values only if 7.2 item 6 is answered yes. Please confirm the reason set of DD 3.2 is closed (six reasons).
7. **Special price end:** `specialEndsAt` with the seller's IANA zone, or nothing shown. Optional write "acknowledge price" if 7.2 item 4 is yes.
8. **Seller shop address** in `sellerSummaries` (slug or path key) if 7.2 item 14 is yes.
9. **Idempotency of add:** the add increments, so a repeated request doubles the quantity. The UI prevents double presses and, after an unknown outcome, re-reads first (F22 step 8). Is there a platform idempotency key
   I should send on add, change and remove?
10. **Image URLs:** the display data gives an image key; the panel needs the public URL rule and the rendition sizes (CAT-UX 3.5: public origin, server-made renditions only).
11. **Conflict handling:** on `conflict.stale` and `conflict.retry` the panel re-sends once (F22 step 7). Confirm the add is safe to re-send after a 409 (DD 10 says nothing was written).

### 7.4 For Hassan
1. Cart responses are `no-store` and the panel re-reads on `pageshow` with `persisted` (3.0 rule 4, F25 step 9). Confirm.
2. The merge call carries `x-csrf-token` (DD 6.5); a guest write relies on strict JSON content type, no state change on a safe method and no CORS with credentials (DD 4). The panel sends `application/json` only and uses `fetch`
   with same-origin credentials. The count endpoint must obey "no state change on a safe method" (it never sets a cookie).
3. The panel never reads, stores or sends the guest token (HttpOnly). The merge banner stores only counts in `sessionStorage` (try/catch). Confirm this convenience is acceptable or drop it.
4. Telemetry records no cookie, id, product, seller or amount from cart screens; error codes only.
5. Throttle texts are the same for all counters (F22 step 6) so a probe learns nothing about which limit was hit.

### 7.5 For `ordering` G2 (hand-off)
1. The checkout's first call is `cart.getCheckoutLines`; on `cart.not-ready` `ordering` sends the customer back to B6 (proposal: `/cart` with a query value that carries a code, never ids), and B6 shows `cart.error.not-ready`.
2. The stock case the cart cannot see (a quantity above stock when the status is IN_STOCK, `inventory.insufficient` `not-enough` without a number, DD 3.2) is shown by `ordering`'s own UI; it must not show a number above the
   threshold (brief section 5) and should send the customer back to B6 or let them lower the quantity in place. Cart's `reduce-quantity` exists only for LOW stock.
3. Checkout shows frozen prices; cart never passes a price (DD 6.6). Cart's "Items subtotal" and checkout's total can differ (price changed, tax): the wording must not say they will match.
4. Clearing purchased lines after an order (`clearPurchasedLines`): the customer who returns to B6 sees the remaining lines only; no UI.
5. Which words `ordering` uses for the minimum order if it re-applies it: the same keys as `cart.group.below-minimum` and `cart.group.check-unavailable`.

### 7.6 Needing the owner
**None.** Everything that touches a business rule is already answered (owner answers of 2026-10-07 and the brief). Two items could reach the owner through Hadi if he chooses: whether a price change may be acknowledged without changing
the quantity (7.2 item 4), and which storefront carries the cart in Phase 5 (SA8).

## 8. Hand-off notes

### 8.1 Design track: what to build in Figma, in order
Follow `docs/design/figma/update-procedure.md` (Sandbox, review, publish, Export tokens). One release, "Cart (buyer)", MINOR, the next free number when published (section 4).
1. **Foundations first:** icon `shopping-cart`; token `size/thumb-lg`; `InfoBanner` Size=Compact; `ProductThumb` Size=Large; `Dialog` Layout=Side.
2. **Components:** `QuantityStepper` (all states, both sizes, Updating and Error, Show remove); `CartLine` (Full and Compact; Default, Updating, Unbuyable with each of the six reasons, Removed/undo row, Error, Loading); `SellerGroup`
   (Default, Below minimum, Cannot check, No buyable line, Loading; Full and Compact); `CartSummary` (Card, Sticky, Footer; Ready, Blocked, Guest, Loading).
3. **Templates · Storefront** (new section): `Storefront · Cart`: empty; one seller; three sellers; a group below its minimum; a group that cannot be checked; every line reason in 3.1.1; price up and price down;
   special price with and without an end time; LOW stock with and without `reduce-quantity`; a `CertChip` line and a line without badge data; the undo row; each write error; the blockers banner; partial check; refresh failed;
   not-ready return; guest card; B9 in its four states; signed-in ready; loading. `Storefront · Cart controls`: B7 in every state of 3.1; B8 (empty, 3, 99+, current page); D11 (loading, default, blocked, empty, error; Side
   and Sheet). Every frame in light and dark, 360, 760 and 1280 (Touch density at 360 and 760), en and fa/RTL, and the ZZ fixture for B6 and D11. A labelled placeholder header frame, not a component.
4. Release checklist: README section 8, both themes, Audit with zero warnings, token export, changelog, README counts, `claude/design-status.md`. Owner review: a short Persian summary with screenshots of B6 (blocked,
   with a below-minimum group and a price change) and the guest card.

### 8.2 Frontend track: which screens wait for which backend slice
Every screen also waits for the storefront shell and the product page (SA8, 7.1), the customer sign-in screens (ID-UX A1 to A6, Cus), ID-UX D1 and D2 ADRs and slice F0 (ADR-0017).
| Screens | Backend slice (DD 13) | Library release |
|---|---|---|
| B7 (add), B8 (count), B6 with lines, quantity, remove, undo; empty, loading, error | 1 (needs `catalog.offerListings`, SC1, PC1, IC1; the count endpoint) | Cart (buyer) |
| B6 grouping with "Sold by", all line states of 3.1.1, price-change notice, `CertChip` line, D11 | 2 (needs SC2) | Cart (buyer); chips need the CUX release |
| Guest variants of B6 and B7, the guest card, B9 and the merge call after sign-in | 3 (**Hassan's review first**) | Cart (buyer) |
| Group minimum-order messages (`group.below-minimum`, `group.check-unavailable`) | 4 (waits for `sellers` slice 20) | Cart (buyer) |
| "Check out" hand-off, not-ready return | 5 (with Phase 5, **Hassan's review**; re-confirmed at `ordering` G2) | Cart (buyer) |

- Build every state and every notice from the view the API returns; never work out a reason, a readiness or an amount in the panel.
- The panel server sends `x-market-id`. Labels, currency, price basis, limits and the line limit come from the API. Frontend acceptance includes the ZZ fixture rendering of B6, B7 and D11.
- Write calls go one at a time per cart, with the debounce of F24; writes are sent as `application/json` only; the merge call carries `x-csrf-token`.
- Tests the frontend adds: no cart data in storage; `pageshow` re-read; a line with no badge data shows no chip; every reason of 3.1.1 renders its text and its action; the minimum-order sentences equal the SL-UX 3.1a text;
  live-region messages for update, remove, readiness and merge; keyboard path through the stepper, Remove, Undo and "Check out"; D11 focus trap and return.
- Telemetry never records cart contents, ids or amounts.

## 9. Review record (2026-10-08)

| Reviewer | Result | What was applied |
|---|---|---|
| Reza (ui-ux-designer) | Author. Reason codes of DD 3.2 checked (condition 4); notes in 3.2 and 7.3 | — |
| Jafar (product-designer) | Pending | 7.1 and 7.2 |
| Mohammad (software-architect) | Pending | 7.3 |
| Hassan (security-tester) | Pending | 7.4 |
| Hadi (product-owner) | Pending | 7.2 items 1, 2, 4, 9 and 10 |
| Ali (cto) | Pending | Section 4 (release number), 8.2 |
| Owner | Not needed (7.6) | — |
