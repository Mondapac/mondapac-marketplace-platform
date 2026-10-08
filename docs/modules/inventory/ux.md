# inventory: flows and screens (G2 UX specification)

| | |
|---|---|
| Author | Reza (ui-ux-designer), 2026-10-08 |
| Status | **Draft for review.** It answers the UI condition of the `inventory` G2 (brief approval row, "no UI slice before Reza's `ux.md` and the Figma-first update", ADR-0017). Not approved. Section 9 lists the reviewers still to answer |
| Module | `inventory`, tier A, Phase 4. G1 approved by the owner 2026-10-07; G2 approved with conditions 2026-10-07 (slices 1 to 4; the ordering port and slice 5 are re-confirmed at `ordering`'s G2) |
| Reviewers asked | Jafar (product-designer), Mohammad (software-architect), Hassan (security-tester), Ali (cto); Mojtaba (database-designer) only for API needs 9 and 10 |
| Used for | Brief section 12 (filled in section 4 here), the Figma work (ADR-0017), and the frontend slices of section 8.2 |

**Ground truth.** `docs/modules/inventory/brief.md` (sections 2 to 7, 10, 12); `docs/design/domain/inventory.md` ("DD"; sections 2 to 7, 12, 14); `docs/design/data/inventory.md` ("DM"; sections 3.3 to 3.5, 11); the owner answers of `phase-4/design/owner-answers.md` (Q-O1: Hassan's cap rule); `docs/design/panels/information-architecture.md` ("IA": templates T1 to T9, nav config, routes `/catalogue/stock` and `/settings/stock-locations`); `docs/design/figma/README.md` (library **1.8.3**) and `docs/design/tokens/`; `docs/modules/identity/ux.md` ("ID-UX"), `docs/modules/sellers/ux.md` ("SL-UX": `DataRow`, `FormActionBar`, `SettingRow`, `Field` Status, copy and acting-as rules) `docs/modules/catalog/ux.md` ("CAT-UX": the Offer form slot "Price and stock", throttle rule, reorder pattern) and the draft `docs/modules/cart/ux.md` ("CART-UX": cart-line stock notices; the cart line reuses this spec's `inventory.availability.*` keys "In stock", "Only {count} left" and "Out of stock", it keeps no copy of its own) and the draft `docs/modules/pricing/ux.md` ("PRC-UX": the "Price and stock" slot, `PriceTag`). "AC n" is the n-th acceptance criterion of brief section 10 **counted in the brief's order (15 criteria)**; DD 9 cites some of them one number lower (open point 15).

**Not verified.** The Figma file was not opened. The library inventory comes from its README (1.8.3), `icons.json` (68 icons) and the planned releases named in SL-UX 4 and CAT-UX 4; those releases are **planned, not built** and this document assumes them. `StatusBadge`, `SettingRow` and `DataRow` properties were not inspected, so every "change" in section 4 is a proposal to confirm in the file. No research with real sellers exists: whether sellers keep more than one stock location, and how they update stock on a phone, is unknown ("For Jafar"). Values that live in Market configuration appear as `{names}`; the AU values (15 minutes, 10, 99, 4) are examples only.

**IDs.** Continue SL-UX: S = seller-panel screen, P = admin-panel screen, C = card, D = dialog, E = email, F = flow. **First free numbers used here: S8, P5, C2, D12, F29.** E27 would be the first free email (E24 is SL-UX's unbuilt proposal; `pricing` takes E25 and E26); none is designed. **Buyer-facing elements use one scheme, B, shared by the three Phase 4 buyer drafts: `cart` keeps B6 to B9, this spec uses B10 to B12, `pricing` uses B13 to B15** (ID-UX owns B1 to B5; certification keeps CB1 to CB3 for now). `catalog` and `certification` use their own prefixes (PS, PA, DP, FP; CS, CA, DG, FL), so nothing collides. Codes are the API codes of DD 4.2, 4.5, 5.4 and 7.1; the UI maps each to a translation key and never shows server text (INTL-11). A code marked "(name to confirm)" is a need, not a decision (section 7).

## 1. Scope and inventory

Phase 4 UI for `inventory`: **three seller-panel screens, two cards (one on the Offer form, one on Home), two admin-panel screens, three buyer-facing elements and two dialogs, no emails.** The buyer elements are specified here so the label and the checkout messages are designed once next to the rules that govern them (brief s12 lists them); they are **built** by the storefront (Phase 6) and by `cart` and `ordering` (Phase 5). Until then B10 appears inside the seller and admin panels.

### 1.1 Screens
| ID | Name | Panel | Route (IA) | Template | Backend slice (brief s11) | AC | Priority |
|---|---|---|---|---|---|---|---|
| S8 | Stock | Seller | `/catalogue/stock` | T2 | 2 (rows, numbers), 3 (status), 4 and 5 (held, ordered figures) | 4, 5, 7, 8 | P0 |
| S9 | Stock locations (list, order, add, edit) and the low-stock alert | Seller | `/settings/stock-locations` | T7 | 1 (locations), 3 (alert) | 2, 7, 10 | P0 (INV-01, SEL-10, INV-04) |
| S10 | One item: by location, and its history | Seller | `/catalogue/stock/:offerId/:variantId` | T3 | 2 | 9, 11 | P0 |
| C2 | Stock card on the Offer form (fills the "Price and stock" slot of PS3 and PS7), with the limit per customer | Seller | inside `/catalogue/products/:id`, `/catalogue/offers/:id` | T6 card | 2; the limit field 4 | 9, 12, 13 | P0 (OFR-02) |
| C3 | "Running low" card on Home | Seller | `/` | T1 card | 3 | 7 | P0 (INV-04) |
| P5 | Seller stock (tab "Stock" on the seller page P2) | Admin | `/sellers/:id/stock` | T3 tab | 2 (admin read; slice to confirm, open 16) | 8, 11 | P0 |
| P6 | One item of a seller: by location and history | Admin | `/sellers/:id/stock/:offerId/:variantId` | T3 | same as P5 | 11 | P0 |
| B10 | Availability label (In stock, Only N left, Out of stock) | Buyer, seller, admin | n/a | `StatusBadge` values | 3 | 7, 8 | P0 |
| B11 | Quantity limit and "not enough" messages | Buyer | cart, checkout | messages | 4 | 1, 3, 13 | P0 (design-ahead) |
| B12 | Checkout hold notice (15 minutes, ending, ended, sold out) | Buyer | checkout | `InfoBanner` | 4, 5 | 4 | P0 (design-ahead) |

Dialogs: **D12** Add or edit a stock location; **D13** Change stock (one item, every location). The unsaved-changes dialog (library 1.8.3) and **D3** (SL-UX; no new use) are reused.

### 1.2 Emails
**None designed.** The brief gives the seller the dashboard alert (brief s4 flow 6) and no email; `inventory` publishes `low-stock-reached` as an event only; the `notifications` module is Phase 6. A low-stock email would be **E27**, a proposal for Hadi, not in the counts (open point 2). Customers get no inventory email: a hold is not an order.

### 1.3 Not designed, and why
- **Manage Stock off (INV-02):** P1, after launch (Q4). C2 and S8 leave no slot; the "track stock" switch is designed with that slice.
- **Back orders (INV-05), bulk price and stock (INV-06), Import columns (OFR-11, OFR-12):** outside the brief. S8 has no multi-row edit and no CSV.
- **Delete or archive of a stock location, changing the Default, partial shipment:** not in the brief (DD 12.3, 3.4). S9 has no delete; the help says so (F29).
- **Nearest-source choice, customer choosing a location:** later, with `shipping` (Q9). The customer never sees a location.
- **A Market settings screen for the five inventory values** (hold minutes, default threshold, default cap, locations per seller, line ceiling): they live in Market configuration checked at start-up (DD 8), not in a screen, until ADR-0026 (open point 17).
- **Reservation list for sellers or admins:** reservations belong to a customer's checkout and carry an account id; no panel lists them. Sellers see only the counts "In checkouts" and "Ordered, not shipped".
- **Stock-take, supplier receiving, units of measure, fractional or weighed stock:** Q6, whole numbers only.
- **AI:** none (brief s3). **Sync with a POS or external warehouse:** outside the brief.

### 1.4 Changes this spec asks of approved documents
Recorded so Jafar and the owners of those documents can accept or refuse them.
1. **IA 3.2, `s_catalogue`.** Add the child **Stock** (`/catalogue/stock`, key `inventory.stock.view`) beside "Stock locations". IA 5.3 already lists both routes but the nav children list only "Stock locations". Also note that the nav child "Stock locations" points to `/settings/stock-locations` while it sits under Catalogue (open point 17).
2. **SL-UX P2.** The seller page gains a tab **Stock** (P5), shown only with `inventory.seller-stock.view`, which is protected (DD 6). IA 5.2 row "Seller page" gains P5, P6.
3. **CAT-UX PS3 and PS7.** Slot (7) "Price and stock" receives **C2** for the stock part. C2 stays editable while the Offer part is locked for a pending first publication, because stock may be entered before the first publish (DD 4.5). Catalog's owner confirms (open point 18). **Slot order:** catalog's UX owner must also confirm the order inside the shared "Price and stock" slot: the `pricing` summary card (PRC-UX C4) first, this spec's C2 second.
4. **Seller Home (IA 3.2 `s_home`).** Gains **C3** when the user holds `inventory.stock.view`.

## 2. Flows

### F29. Stock locations and their order (Seller Owner, or Staff with `inventory.source.edit`; brief s4 flows 1 and 2; DD 3.4)
| # | Step | Failure or branch: code and what the user sees |
|---|---|---|
| 1 | After approval the seller **already has one location, the Default**, made by the approval event. There is no setup wizard: S9, S8 and C2 work at once | The first read can arrive before the event ran: S9 and S8 show "We're setting up your stock" with "Try again" (`inventory.not-ready`, name to confirm; API needs 2) |
| 2 | S9 lists the locations in priority order with a position number, the **Default** badge, the optional address and time zone, and "{count} of {max} stock locations used" | Read failure: card-level error with "Try again" |
| 3 | "Add stock location" opens **D12**: name (1 to 80 characters), optional address, optional time zone. Save appends the location **last** | `validation.failed` (name empty, over 80, control or bidi text); `inventory.sources.limit-reached` (details: `max`): "You have {max} stock locations. That's the most MondaPac allows." The button is disabled in advance at the limit, with the same sentence (the limit is a Market setting, so the text says it is MondaPac's limit and not the seller's) |
| 4 | After adding, a status line says the new location is last and offers "Move earlier" | `conflict.stale` (another edit to the seller's inventory in between): "Your stock locations changed somewhere else. We've shown the latest. Check them and try again." The list reloads; the typed name stays in D12 |
| 5 | Reorder: "Move earlier" and "Move later" on each row (no drag-only action). Moves are local until **"Save order"**; the whole ordered list is sent in one request. Each move is announced ("{name} moved to position {n} of {total}") | `conflict.stale`: the list reloads with the latest order and "Your stock locations changed somewhere else…". Leaving with an unsaved order asks first |
| 6 | Edit a location (rename, address, time zone) in D12. The Default can be renamed and moved but **not removed or replaced** | Same codes as step 3 |
| 7 | The page teaches the rule in two sentences and one example (3.1, S9): an order line is filled from the **first location in this order that has all the units**, and a line is never split | n/a |

### F30. Enter and change stock (Seller Owner, or Staff with `inventory.stock.edit`; brief s4 flow 2; AC 9, 11, 12)
| # | Step | Failure or branch |
|---|---|---|
| 1 | The Offer exists (saved by `catalog`). **C2** on the Offer form, or **D13** from S8 ("Change stock"), shows each size with one whole-number field per location, in S9's order. With **one location** the field is labelled "Stock" and no location name appears. An empty field reads "Not set" and means 0 for customers | A brand-new draft with no saved Offer: C2 is disabled with "Add stock after you save your offer." |
| 2 | Under each field the seller sees what limits it: "In checkouts {held} · Ordered, not shipped {ordered}" and **"Lowest you can set: {min}"** (held plus ordered, shown only when above 0). Local checks run on blur and on save: whole number, 0 or more, at most `{max}`, not below `{min}` (the server decides) | `error.quantity.integer` ("Enter a whole number, 0 or more."), `error.quantity.max`. A fractional or non-numeric entry is refused locally and by the server (AC 12) |
| 3 | **"Save stock"** (C2 has its own save; stock is **never autosaved** with the rest of PS3) sends only the changed rows, each with the version the page read. Results are **per row**: rows that saved turn Saved, rows that failed keep the person's entry and show their error | Setting the same value is not a change: that row says "No change." and no Toast says "Saved" when nothing changed (Toast "Nothing changed.") |
| 4 | Below the committed amount: `inventory.stock.below-committed` (name to confirm; details `minimum`): "You can't set this lower than {minimum}. {held} are held in checkouts and {ordered} are ordered but not shipped. Holds end within {minutes} minutes." The field shows the latest minimum; the person can retry later (AC 9) | n/a |
| 5 | `conflict.stale` (a shipment or another person changed the row): "This stock changed while you were editing. The latest is {onHand}. Check it and save again." The row shows the latest and keeps the entry; Save stays enabled. `conflict.retry` (the shop is busy; lock timeout or serialisation failure): "We couldn't save this just now. Try again." | `request.throttled`: CAT-UX rule 11 (3.0 rule 10) |
| 6 | An Offer deleted, a size removed, or an Offer of another seller (or Market): one answer, `not-found`: "We can't find this item. It may have been removed. Reload the page." Byte-identical for all three (AC 11) | n/a |
| 7 | After a save, each changed row states the consequence once, as a status message: "Customers now see: Only 4 left" (Low), "Out of stock" (0) or "In stock". The label is B10; the sentence is not shown for rows that did not change class | n/a |
| 8 | In a "Login as Seller" session (SEL-08) every inventory screen (S8, S9, S10, C2, D13, the alert card) is **read-only**, with the permanent banner of IA 3.3, exactly as `pricing`. Every write is refused with `access.acting-as-refused` (CAT-UX), and the controls are disabled with the reason as text. This holds until the SEL-08 mini-review adds attribution of the acting admin to inventory changes (open point 5). No screen promises that a change "is recorded with your name" | A write that still arrives: `access.acting-as-refused`, shown as `error.acting-as` |

The reason on every change is **recorded by the system** ("Stock set", DD 2.1 `seller-set`); the seller is not asked for one (open point 1).

### F31. Limit per customer (inside C2; brief s5 anti-hoarding, Q11; AC 13)
| # | Step | Failure or branch |
|---|---|---|
| 1 | C2 has one optional field above the sizes, **"Limit per customer (optional)"**, per Offer (not per size): the most one customer can hold in a checkout | `validation.failed` when not a whole number from 1 to `{max}` (the line ceiling, 99 in AU): "Enter a whole number from 1 to {max}." |
| 2 | Help: "Leave it empty to use MondaPac's limit: up to {defaultCap}, and fewer when stock is low." The seller's number replaces the default for this Offer (Q11, Q-O1). It is shown to customers as "Limit: {limit} per customer" (B11) | Removing the limit: text action "Remove limit" (saves with the card) |
| 3 | The limit saves with the stock card (its own request) and shows its own result | Failure keeps the stock rows' results separate |

### F32. Low-stock alert and "Only N left" (Seller Owner, or Staff with `inventory.settings.edit`; INV-04, Q7, Q8; AC 7)
| # | Step | Failure or branch |
|---|---|---|
| 1 | S9 card **"Low-stock alert"**: two options, "MondaPac default ({default})" or "My own number", and a number field 0 to 99. A live preview line says what customers will see (3.1, S9) | `error.alert.range` for anything else; for 0 the preview says that customers never see "Only N left" and no alert is raised |
| 2 | Save. The status line says when it applies: "A new number applies to each item the next time its stock changes." (**default wording**: DD 5.3 does not recompute signals when the threshold changes; if Mohammad adds that, the line becomes "Applies at once.", open point 3) | `conflict.stale`, `request.throttled` as elsewhere |
| 3 | When an item's "available to customers" falls to the threshold or below, the **public label becomes "Only N left"** (B10), the item gets a Low badge on S8, and C3 lists it on Home. At 0 the label is "Out of stock" and C3 counts it separately. Raising stock above the threshold clears all three | The Home card and S8 tab counts may lag the stored public status by up to a minute after a hold expires (the expiry job runs every minute, DD 11); S8 says "Updated {time}" and offers "Refresh" |
| 4 | The seller learns of it only by the dashboard (no email, 1.2) | n/a |

### F33. A customer's hold, from checkout start to release (design-ahead; `ordering` and `cart` build the page; Q1, Q2, Q-A2; AC 4)
| # | Step | What the customer sees (B12) and what changes |
|---|---|---|
| 1 | Checkout starts: `ordering` asks to hold **every line of the cart in one request**. If all lines fit, they are held for `{minutes}` (15 in AU) | Info banner: "We're holding your items for {minutes} minutes while you check out." and, refreshed at most once a minute, "About {n} minutes left." Sellers' S8 shows the units under "In checkouts" |
| 2 | Two minutes before the end | Attention banner (`role="alert"`, once): "Your hold ends in about 2 minutes. After that your items aren't held, and someone else could buy them." |
| 3 | Payment succeeds in time | The hold becomes an order (the units move to "Ordered, not shipped" on S8). `ordering` shows its own confirmation |
| 4 | The hold ends before payment | Attention banner: "Your hold ended. Your items aren't held any more. You can still pay if they're still available." with **"Hold my items again"**. Paying anyway asks again: if every line still fits it is taken, otherwise step 7 |
| 5 | The customer starts another checkout (another tab or device) | The older hold is released and replaced. Paying on the older page still works if the items fit (DD 3.1, `superseded`). Copy: "You started another checkout, so this one was replaced." only if `ordering` can tell the cause (open point 10) |
| 6 | The customer cancels, the payment fails, `ordering` cancels, or the Offer was moved to a shared product while held | The hold is released at once (stock returns for others). The checkout page says "This checkout can't continue. Go back to your cart and start again." These causes are final: payment on them is refused. The page never names the cause |
| 7 | Payment arrives for a hold that cannot be taken again | Attention: "Some items sold out while you were checking out. Review your order." plus the per-line reasons of B11. Whether "You haven't been charged." may be said is `ordering`'s and legal's (L; open point 11) |
| 8 | A seller is suspended or an Offer deleted mid-hold | The hold stays until it ends (Q5, AC 6); `ordering` refuses at payment. Nothing inventory-specific is shown |

### F34. "Not enough" and two buyers for the last unit (design-ahead; AC 1, 2, 3, 13)
| # | Step | What the customer sees |
|---|---|---|
| 1 | Checkout asks to hold all lines. If **any** line cannot be held, **no line is held** (AC 3), including lines of other sellers | Critical summary above the lines: "We couldn't hold your items, so none of them are held. Fix the items below and try again." |
| 2 | Each failing line carries one reason from `inventory.insufficient`: `out`, `not-enough`, `over-limit`, `retired`. The reasons never carry a number | `out`: "{item} is out of stock." `not-enough`: "We don't have enough of {item} right now. Lower the quantity or remove it." `over-limit`: "You can't order that many of {item} at a time. Lower the quantity." (with `{limit}` only when the API gives the seller's limit or the public cap, 3.3 B11). `retired`: "{item} is no longer for sale. Remove it to continue." |
| 3 | Two customers want the last unit at the same moment: exactly one is held (AC 1). The other sees `out` or `not-enough` on that line, as above. There is no "someone else got it" sentence and no number | n/a |
| 4 | The customer lowers the quantity or removes the line and presses "Try again" | `request.throttled` (6 holds per 15 minutes and 30 a day per account; 30 per 15 minutes per network, DD 5.4): "You've started checkout too many times. Try again in {minutes} minutes." (from `retryAfterSeconds`; the daily limit reuses `error.limit.daily`). `access.unavailable` (the limiter failed and the hold fails closed): "We can't hold your items right now. Try again in a moment." `conflict.retry`: "We couldn't hold your items just now. Try again." |
| 5 | Nothing on the page says whether a larger quantity "would fit". The page never offers a "maximum you can order" computed from a failed attempt | n/a |

### F35. Admin reads a seller's stock for a complaint (Admin with `inventory.seller-stock.view`; brief s2, s9; DD 6)
| # | Step | Failure or branch |
|---|---|---|
| 1 | On P2 the tab **Stock** appears only with the protected key. The admin Viewer role does not receive it by default; a Platform Administrator can grant it | No key: the tab is absent and the URL gives B5 "no access" |
| 2 | The tab opens on a card: "Viewing a seller's stock is recorded." with **"Show stock"** (the P2-H pattern of SL-UX). Each press records an audit row | Not found for another Market's seller id: B5 "not found", byte-identical |
| 3 | P5 shows the locations (name, Default, order; **never the address**) and the stock table. A row opens P6 (by location and history) | Load error with "Try again" |
| 4 | Everything is read-only. There is no edit, no adjustment, no hold release for admins (brief s2) | The page says so in one line |

### F36. When products change under the stock (brief s6, DD 3.5, 3.6; AC 6)
| # | Event | What the seller sees |
|---|---|---|
| 1 | A size is removed, or the Offer is deleted | Its stock is retired. The row leaves S8 and C2; orders already placed keep their pending units. If the seller adds the size again it **starts empty** (the catalog copy already says so) |
| 2 | The seller's duplicate product is matched to a shared product (CAT-45) | The stock moves to the new size automatically. S10's history shows one entry "Moved when your product was linked to a shared product" on the old item and one on the new item. No action is asked |
| 3 | A stock write arrives for a size that was just retired | `not-found` (F30 step 6) |

## 3. Screen specifications

### 3.0 Rules for every screen
1. **Shells and routes.** Seller screens use the full seller shell (the catalogue is not on the limited allow-list; `whenSellerNotApproved: 'deny'`, DD 6). Admin screens use the admin shell, inside P2. Frames keep `Sidebar` and `Topbar` as instances. The phone navigation of IA 4 (drawer and the seller bottom bar, "Catalogue" tab) already exists, so nothing here waits for it.
2. **Whole numbers only (Q6).** Every quantity field is `type="text"`, `inputmode="numeric"`, `autocomplete="off"`, `dir="ltr"`. No `type="number"`, no steppers, no scroll-wheel change. Parsing is by the page locale with `Intl`: Latin, Persian and Arabic-Indic digits and the locale's grouping mark are accepted; a decimal mark, a minus sign or an exponent is an error, not a rounding. Display is `Intl.NumberFormat` in the page locale. Pasted text is trimmed.
3. **Who sees which number (AC 8).**
   | Audience | Sees |
   |---|---|
   | Customer (storefront, cart, checkout, events, URLs) | In stock, Only N left (only at or below the threshold), Out of stock. **Never an exact number above the threshold.** The cap, only when the seller set it or it comes from the public N |
   | Seller (own shop only) | Exact on hand, held, ordered, available, per location |
   | Admin with the protected key | The same, read-only, audited |
   Exact numbers are never written to a URL, a page title, telemetry or browser storage.
4. **Words (the module uses these and no others).**
   | Word | Means | Never use |
   |---|---|---|
   | Stock location | One of the seller's places that holds stock (brief: انبار). The seller names it | "Warehouse", "source", "inventory" in labels |
   | On hand | What the seller counted at a location | "Quantity" |
   | In checkouts | Units held for customers who are checking out; ends by itself | "Reserved" (the seller word is "held") |
   | Ordered, not shipped | Paid orders not yet marked shipped (INV-03) | "Pending ordered quantity" |
   | Available to customers | The most one order can contain: the largest amount at any single location | "Sellable", "buyable", "in stock" for this number |
   | Low-stock alert | The seller's threshold | "Threshold" in seller copy |
   | Limit per customer | The Offer's cap on one customer's hold | "Cap" in seller copy |
   | Hold (buyer copy) | The 15-minute reservation | "Reservation", "reserved" in buyer copy |
5. **Market-driven values** arrive from the API and are never in the frontend: hold minutes, default alert, default limit, locations per seller, line ceiling, maximum stock, time-zone list, address fields (same descriptors as SL-UX S3 if the API reuses them, API needs 4). No "15", "10", "99", "4" or "AU" in code. The ZZ fixture (other hold time, other default alert and limit) must render S8, S9, C2, B10 and B12 with no code change.
6. **Permissions in the UI** follow ID-UX 3.0 rule 6, from the allowed-actions list the API supplies:
   | Key | Gives |
   |---|---|
   | `inventory.stock.view` | S8, S10, S9 (read), C2 and D13 (read), C3, the nav items |
   | `inventory.stock.edit` | C2 and D13 saves, the limit per customer |
   | `inventory.source.edit` | D12, "Save order" |
   | `inventory.settings.edit` | The low-stock alert |
   | `inventory.seller-stock.view` (protected, platform) | P5, P6 |
   View without edit: fields read-only and the page says "You can view stock but not change it. Ask your shop owner." (a disabled control gives its reason in text and stays focusable). No view key: no menu item and B5 on the URL.
7. **Dates and times.** A time that belongs to the seller (ledger entries, "Updated") is shown in the **seller's work time zone, named**, for the seller and the admin alike (SL-UX 3.0 rule 8). Hold lengths are durations in minutes; the customer page shows no clock time (the customer has no stored zone, open point 8).
8. **Never, on any screen:** an exact stock number to a customer above the threshold; "fits / doesn't fit" for a quantity; a customer name, account id or checkout id in a seller or admin view; a source address to an admin; a price or Cost; a server message string; the words "reserved", "sellable", "buyable" in panel text; a promise that "Only N left" is current to the second.
9. **Storage and cache.** Edit forms (C2, D12, D13, the alert card) keep typed values **in memory only**: no localStorage, sessionStorage, IndexedDB or service-worker cache. Responses with exact numbers, location names or addresses are `Cache-Control: no-store`. Location names and addresses may hold personal data (DM 3.3): never in a URL, title or telemetry; display uses `dir="auto"` and shows exactly what was typed. **Location names and addresses are inert plain text everywhere** (panels, dialogs, status messages, `aria-label`s such as "Move {name} earlier", exports): no HTML, no links, no markup is interpreted or created from them (no auto-linked addresses, phone numbers or map links); they are rendered as text nodes only.
10. **Throttled requests** follow CAT-UX 3.0 rule 11 (lists keep rows and show the Attention banner; actions keep the form open and show the line beside the button; the daily limit has no retry).
11. **No polling.** Pages read on load, on window focus and after a save (ID-UX F5). Held counts change by the minute; S8 shows "Updated {time}" and "Refresh".
12. **Form pages** follow SL-UX 3.0 rules 2 and 3: error summary takes focus; field errors are icon plus text; primary button `State=Loading` at the same width; lists load as 8 skeleton rows; no page spinner; session ended returns to the same page and unsaved text is not kept.

### 3.1 Seller panel
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **S8 Stock** (T2). See every item and its numbers, change them | H1 "Stock" with the item count. Tabs with counts: **All**, **Low stock**, **Out of stock**. Search (name, size, SKU; a POST body, never in the URL). Table: **Item** (`ProductThumb`, name, size label), **What customers see** (B10), **Available to customers**, **In checkouts**, **Ordered, not shipped**, **On hand** (all locations added up). Column headers carry the helps of section 5 behind an info button. Row menu: Change stock (D13), History (S10). Line under the table: "Updated {time}" and "Refresh". Items with no stock saved show "Not set" and the label Out of stock | Search needs 3 characters. Row menu from the allowed-actions list. A banner explains the one rule sellers misread: "Customers can order the most you have at one location, because each item in an order comes from one location." (dismissible per session only; not stored) | Skeleton (8 rows); **empty** ("You have nothing to stock yet. Add a product first." with "Add a product"); per-tab empty ("Nothing is running low.", "Nothing is out of stock."); no search result ("No items match."); **setting up** (F29 step 1); load error with "Try again"; throttled; view-only (no row action but History); no view key: B5; acting-as: read-only with the banner (no "Change stock"; `access.acting-as-refused`) | A customer, a checkout id, a price; items of other sellers; a number for a retired item; the Default's address |
| **S9 Stock locations** (T7 two sections) | H1 "Stock locations". Card 1 **Locations**: the two sentences and the example (section 5, `locations.intro`, `.example`) in an expandable "How orders are filled"; "{count} of {max} stock locations used"; `LocationRow` list in priority order: position, name, **Default** badge on one, address summary, time zone, "Move earlier", "Move later", "Edit"; primary "Add stock location" (D12). A `FormActionBar` appears when the order changed: "Save order", "Cancel", status "Unsaved order". Card 2 **Low-stock alert** (a `SettingRow`): `SegmentedControl` "MondaPac default ({default})" / "My own number"; with "My own", a number `Input` "Alert at (0 to 99)"; the preview line; the applies line (F32 step 2); a card `FormActionBar`. Line "You can't remove a location yet. To stop using one, set its stock to 0." | Name: 1 to 80 characters, no outer spaces, no control, bidi or URL-like text. Address (optional): the Market's address fields (API needs 4). Time zone (optional): `Select` of IANA zones from the API, empty = "Your shop's time zone". Alert: whole number 0 to 99 | Default; dirty order; saving; saved; **setting up**; at the limit (Add disabled with the reason); `conflict.stale` (list reloads); view-only (rows read-only, the alert card read-only, text "You can view stock but not change it."); alert saved Toast "Low-stock alert saved."; load error per card; no view key: B5; acting-as: read-only with the banner (rows, order, alert card and "Add stock location" disabled with the reason `error.acting-as`) | Another seller's locations; a customer-facing preview of a location (customers never see locations); an order count per location |
| **S10 One item** (T3). Understand and trace one item | Back link "Back to stock"; H1 item name and size; summary: B10 "What customers see", "Available to customers {n}" with the help "Your total is {total}, but customers can order {available} at once. Each item in an order comes from one location." (only when they differ). Card **By location**: a table (`DataRow` Layout=Single or table) Location, On hand, In checkouts, Ordered, not shipped, Available; with one location the card is one line. "Change stock" (D13). Read-only line for the Offer's limit per customer with a link to C2. Card **History**: a table Location filter (`Select`, default the first location), When, Change (+n or −n with icon), Level after, Reason, By. "Show more" (keyset paging) | History is read per location because the ledger is indexed per stock item (DM 3.5; API needs 9). Times in the seller's zone, named. The entry "Moved when your product was linked to a shared product" appears on both the old and new item (F36) | Skeleton; empty history ("No changes yet."); load error; item not found: B5 "not found" (also for a retired or another seller's item); view-only: no "Change stock"; acting-as: read-only with the banner. Entries made by an acting admin read "MondaPac, signed in as you" only after the SEL-08 mini-review lets acting-as write; none exist until then | A customer or checkout behind a hold; the order behind a "shipped" entry (the ledger has no order reference, open point 19); an entry's correlation id |
| **C2 Stock card** (inside PS3 and PS7, slot "Price and stock"; a sub-card with its own save) | Card header "Stock" and one help line. **Limit per customer (optional)** (F31). Then one **`StockRow`** per size (the Offer's sell units, in catalog's order): the size label, B10 for the current state, one field per location, the context line and "Lowest you can set". Footer `FormActionBar`: "Save stock", status ("Unsaved stock changes", "Saved") | As F30 and F31. The card is independent of the Offer part's save and of autosave; leaving the page with unsaved stock asks first | Default; dirty (per row); saving; saved (per row); "No change"; field errors; `below-committed`; `conflict.stale` (per row); not found (per row); **not available yet** (no saved Offer); **Offer part locked** (pending first publication): the stock card stays editable with the line "You can add stock while your offer waits for review."; view-only; load error with "Try again"; acting-as: read-only with the banner (Save stock and Limit per customer disabled with `error.acting-as`) | The price slot's content; an AI element |
| **C3 Running low** (card on Home, T1) | `CardHeader` "Running low" with a `CountBadge`. Up to 5 rows: item (name, size), B10 label ("Only 4 left"), link to S10. Below: a line "{count} items are out of stock" when any, and "See all low stock" (S8, tab Low stock). One card, no chart | The card reads the Low and Out statuses of this seller only. Empty: "Nothing is running low." (the card stays; a missing card would not tell the seller stock is fine) | Skeleton; empty; load error with "Try again"; no view key: the card is absent | Customer data; a trend; items the seller cannot open |

### 3.2 Admin panel
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **P5 Seller stock** (tab "Stock" on P2) | Before the reveal: the card of F35 step 2. After "Show stock": line "Read-only. Viewing this was recorded."; **Locations** list (`LocationRow` read-only: position, name, Default; no address, no time zone edit); **Stock** table as S8 but without Change stock and without search-by-SKU if not supported: Item, What customers see (B10), Available to customers, In checkouts, Ordered, not shipped, On hand. Tabs All, Low stock, Out of stock. Each row opens P6 | Keyset paging by Offer. Each load of stock is an audited read (API needs 11) | Not shown yet (reveal card); loading (8 skeleton rows); empty ("This seller hasn't entered any stock."); load error with "Try again"; no key: tab absent, B5 on the URL; throttled; view-only is the only mode | Any edit control; the address of a location; account ids; reservations; prices |
| **P6 One item of a seller** | As S10 without "Change stock" and with an admin line "Read-only. Viewing this was recorded." History: When, Change, Level after, Reason, By. "By" shows the kind: "Seller team member", "MondaPac admin (acting as the seller)", "MondaPac system"; names only where `identity` supplies them (API needs 9) | As S10 | As S10; not found for another Market's seller or item: B5, byte-identical | As S10 plus the seller's addresses |

### 3.3 Buyer-facing elements (design-ahead; built in Phase 5 and 6)
**B10 Availability label.** One element, three states, built from `StatusBadge` values (section 4), with icon, tone and words, never colour alone.
| Public status (DD 5.2) | Words | Tone, icon | Where |
|---|---|---|---|
| `IN_STOCK` | "In stock" | Success, `check` | Product page, Offer list, cart line, S8, S10, P5 |
| `LOW` with `onlyLeft` | "Only {count} left" | Attention, `alert-circle` | Same. `{count}` is the public N, at most the threshold |
| `OUT` (also: no stock saved, all retired) | "Out of stock" | Neutral, `x` | Same; the cart disables "Add" and checkout is blocked on that line |
Rules: the label is built only from the API's `status` and `onlyLeft`, never from a number the page computed; with `LOW` and no `onlyLeft`, or an unknown status, **nothing** is shown (fail closed, no placeholder); an `Out of stock` Offer is still listed by `catalog` (listed means published, not in stock); the label sits near the price in the buyer pages and in `What customers see` in panels, with `Style=Text` (no background) on the buyer product page. Persian and Arabic render the number with the locale's digits.

**B11 Quantity limit and "not enough" messages (checkout; the cart's own line notices `reduce-quantity` and `out-of-stock` are CART-UX 3.1.1; the cart line shows availability with B10's keys `inventory.availability.*`, with no duplicate keys in `cart.`).** Reasons come from `inventory.insufficient` (F34). Presentation rules: one Critical summary above the lines and one message under each failing line (icon plus text, `aria-describedby` on the quantity field); the failing quantity stays typed; nothing is shown that implies how many would fit. The **limit** is shown as "Limit: {limit} per customer" only when the API supplies it (the seller's number, or the public rule: the smaller of `{defaultCap}` and half the public N, rounded up; DD 5.1, 5.4); otherwise the numberless message is used. The cart's quantity maximum is `{lineCeiling}`, or the public N when the label is Low (CRT, brief s5).

**B12 Checkout hold notice.** `InfoBanner` states, one visible at a time, text only:
| State | Tone | Words | Notes |
|---|---|---|---|
| Holding | Info | "We're holding your items for {minutes} minutes while you check out." then "About {n} minutes left." | Remaining time is computed from the server's expiry and server time (API needs 12), refreshed at most once a minute, **not** a live region and **not** a countdown ring |
| Ending | Attention, `role="alert"` once | "Your hold ends in about 2 minutes. After that your items aren't held, and someone else could buy them." | At least 20 seconds of warning. **WCAG 2.2.1 is unresolved** (section 6, open point 7). Offers "Hold my items again" |
| Ended | Attention | "Your hold ended. Your items aren't held any more. You can still pay if they're still available." | "Hold my items again" asks `ordering` to hold again; subject to the limits of F34 step 4 |
| Sold out at payment | Critical | "Some items sold out while you were checking out. Review your order." | Per-line reasons follow; the "not charged" sentence is `ordering`'s (L) |
| Final | Critical | "This checkout can't continue. Go back to your cart and start again." | After cancel, payment failure, `ordering` cancel or an Offer moved while held |
| Cancel checkout (optional action) | Dialog | "Cancel checkout?" "We'll stop holding your items." | Calls the customer's own release; whether `ordering` offers it is open (10) |

### 3.4 Reservation states in words
The domain states (DD 3.1, 3.2) are never shown as such. This table fixes what each audience reads.
| Domain state | Seller sees | Admin sees | Customer sees |
|---|---|---|---|
| `ACTIVE`, not expired | Counted in "In checkouts" | Same | B12 Holding or Ending |
| `ACTIVE` past its time, or `EXPIRED` | Not counted (the number drops at once; the stored label may lag a minute) | Same | B12 Ended |
| `RELEASED`: `superseded`, `customer`, `cancelled`, `payment-failed`, `offer-moved` | Not counted | Same | `superseded`: Ended (a late payment can still be taken); the rest: Final |
| `COMMITTED` (line) | Counted in "Ordered, not shipped" | Same | `ordering`'s order page |
| `FULFILLED` (line) | Leaves "Ordered, not shipped"; History: "Order shipped", on hand −n | Same | n/a |
| `CANCELLED` (line) | Leaves "Ordered, not shipped"; units available again | Same | n/a |

### 3.5 Dialogs
ID-UX 3.3 rules apply (title names the action and object; primary repeats the verb; focus trap and return; sheet layout below 480 px; no outside-click close while text is typed).
- **D12 Add or edit a stock location.** Two modes. Fields: Name (required), Address (optional; the Market's fields, collapsed under "Add an address" until opened), Time zone (optional `Select`). Help under Name: "Your own label, for example “Brisbane storeroom”. Customers don't see it. Use a place, not a person's name." Add mode primary "Add location"; edit mode "Save location". Errors: `validation.failed` (field), `inventory.sources.limit-reached`, `conflict.stale`. The Default shows its badge and "Your first location. It can't be removed." in edit mode.
- **D13 Change stock.** Title "Change stock: {item}". One `StockRow` for the item (every location, context and "Lowest you can set"), the same checks and per-row results as C2. Primary "Save stock", secondary "Cancel". The dialog stays open on a row error. After a successful save it closes and S8 shows the row's consequence line as a status message. Below 480 px it is a sheet with the row in Card layout.

### 3.6 Empty, loading, error and locked, in one place
| Surface | Empty | Loading | Error | Locked or read-only |
|---|---|---|---|---|
| S8 | "You have nothing to stock yet. Add a product first." | 8 skeleton rows | "We couldn't load your stock. Try again." | View-only; acting-as banner |
| S9 | The Default always exists; "We're setting up your stock" before the event runs | Skeleton rows | "We couldn't load your stock locations. Try again." | View-only; limit reached |
| S10 | "No changes yet." | Skeleton card and rows | As S8 | View-only |
| C2 | "Add stock after you save your offer." | Skeleton rows | "We couldn't load this offer's stock. Try again." | View-only; acting-as |
| C3 | "Nothing is running low." | Skeleton rows | "We couldn't load this card. Try again." | Absent without the key |
| P5, P6 | "This seller hasn't entered any stock." / "No changes yet." | Skeleton | "We couldn't load this seller's stock. Try again." | Always read-only |
Session ended mid-form: the person returns to the same page after sign-in; unsaved text is not kept (3.0 rules 9 and 12).

## 4. Design-system impact (fills brief section 12)

"Existing" is `docs/design/figma/README.md` section 5 (library **1.8.3**: 89 components, 68 icons), plus the components planned in SL-UX 4 and CAT-UX 4 (marked "planned"). All changes are additive: **one MINOR release, named "Inventory"**. It needs the releases that add `DataRow`, `FormActionBar`, `SettingRow` and `Field` Status (SL-UX) and the Offer form template (CAT-UX) first. **This document proposes no number:** the number is assigned at publish by the design track, and Ali orders the releases (open point 14). **`StatusBadge` is changed by both this release and "Pricing"** (PRC-UX 4): the two changes are merged into one change note and built together, so the component is edited once.

| Screen element | Existing library component or template | Change needed in Figma first | Release |
|---|---|---|---|
| Stock row: size label, a quantity field per location, context line, lowest-you-can-set, row state | `Field`, `Input`, `Badge`, `StatusBadge`, `VariantRow` (planned) | New component **`StockRow`**: Layout Row (desktop), Card (below 760 px) and Read (S10, P6); slot "Location fields" (auto-layout that wraps, 1 to many; AU launch has at most 4); TEXT `Item`, `Context`, `Minimum`; State Default, Dirty, Saving, Saved, Error, Conflict (stale), Read-only. The field is an `Input` with `Type=Text` (numeric). Used on C2 and D13 (edit) and S10 and P6 (read) | MINOR Inventory |
| Location row: position, name, Default badge, address summary, zone, move buttons, edit | `Badge`, `IconButton`, `TableCell`, `Menu` | New component **`LocationRow`**: Layout Row or Card; TEXT `Position`, `Name`, `Summary`; BOOLEAN `Default`, `Show actions`; State Default, Moved (unsaved), Read-only. Uses `arrow-up` and `arrow-down` as the move buttons (logical meaning "earlier" and "later", they do not mirror). Used on S9 and P5 (both panels) | MINOR Inventory |
| Availability label | `StatusBadge` | New property value group **`Availability`**: In stock (Success, `check`), Low (Attention, `alert-circle`, TEXT `Detail` for "Only {n} left"), Out (Neutral, `x`); new property **`Style`** (Badge, Text) used by the buyer product page. Used on S8, S10, C2, C3, P5 and the storefront | MINOR Inventory |
| Alert setting with a number | `SettingRow` (planned), `SegmentedControl`, `Field`, `Input` | None: the control slot holds the `SegmentedControl` and the `Input` | n/a |
| Save bar of C2, S9 order, S9 alert | `FormActionBar` (planned) | None | n/a |
| Summary and by-location table | `DataRow` (planned), `TableCell` | None | n/a |
| Running-low card | `CardHeader`, `CountBadge`, `TableCell`, `StatusBadge`, `Button` Link | None; a frame on `Seller · Home` | n/a |
| Hold notice | `InfoBanner` (Info, Attention, Critical) | None. `CountdownRing` is **not** used: a ticking visual is a timing hazard (WCAG 2.2.1, 2.2.2) | n/a |
| Checkout messages | `InfoBanner`, `Field` Error | None | n/a |
| Dialogs D12 and D13 | `Dialog`, `DialogBody`, `Select`, `Input`, `Button` | None to components; frames for each mode and the 360 px sheet | n/a |
| Tabs, search, table, paging, empty states | `Tab`, `FilterChip`, `TableCell` (Loading), `Pagination`, `EmptyState` | None | n/a |
| Icons | 68 plus the SL-UX and CAT-UX additions | **None.** Reused: `package`, `map-pin`, `store`, `arrow-up`, `arrow-down`, `check`, `alert-circle`, `x`, `lock`, `info`, `clock`, `truck`, `search` | n/a |
| Tokens | `size/form-max` (planned), existing colour and status tokens | **None.** Success, Attention, Neutral and Info tokens cover B10 and B12 in light and dark | n/a |
| Templates | T2 `Seller · Orders`, T3 (`Admin · Seller review` planned), T7 `Shared · Settings` (planned), `Seller · Product form` (planned), `Seller · Home`, `Admin · Seller detail` (planned) | New: **`Seller · Stock`** (S8, T2 pattern), **`Seller · Stock item`** (S10, T3 pattern), **`Admin · Seller stock item`** (P6). Updated frames: S9 on `Shared · Settings`, C2 states inside `Seller · Product form`, C3 on `Seller · Home`, P5 as a tab of `Admin · Seller detail`, 360 px frames for S8, S9, S10, C2, D13 | MINOR Inventory |

- **New components (2):** `StockRow`, `LocationRow` (each used in two places or both panels, as the update procedure requires). **Changed components (1):** `StatusBadge` (a value group and a property; one change note with the `pricing` values, see above). **New tokens:** none. **New icons:** none. **New templates (3)** plus updated frames.
- **Library version after this module: one MINOR** on top of the last release it depends on. Nothing is renamed or removed, so no MAJOR. Light and dark both; the Audit plugin file must be clean (ADR-0017).
- **Brief s12's list:** "stock field per source" and "cannot go below N" error = `StockRow` (`Minimum`, state Error); "sources list with reorder and Default badge" = `LocationRow`; "threshold setting" = `SettingRow` on S9; "low-stock card on the dashboard" = C3; "'Only N left' and 'Out of stock' labels" = `StatusBadge` Availability; "checkout 'not enough' message without numbers" = B11 with `InfoBanner` and `Field` Error. The brief's two "(در G2)" blanks are filled by this section: three templates plus updated frames, one MINOR release.
- **Components not used on purpose:** `CountdownRing` (timing hazard), `VariantRow` (it edits sizes; `StockRow` edits quantities), `ChecklistItem` (nothing here is a checklist).

## 5. Copy

Keys are `inventory.<surface>.<element>[.<variant>]`, kebab-case, ICU MessageFormat, en-AU spelling. Errors are `inventory.error.<code>`; unknown codes use `identity.error.unknown`. Shared keys reused: `error.request.throttled.retry`, `error.limit.daily` (CAT-UX, SL-UX; `pricing` uses the same two), the unsaved-changes dialog, B5. The Market's single tax-inclusive basis key (`market.price.tax-inclusive`, defined in PRC-UX 5) is not used by this module, which shows no price; it is named here so the three Phase 4 documents point to one key. No key in this table repeats the text of another: where two places need the same sentence they use the one key. (L) marks text for legal review. Buyer-facing keys (marked B) are consumed by the storefront, `cart` and `ordering`; their final wording is those modules' to confirm.

| Key (prefix `inventory.`) | en-AU text |
|---|---|
| `nav.stock · nav.locations` | Stock · Stock locations |
| `stock.title · count · search.label · search.help` | Stock · {count, plural, one {# item} other {# items}} · Search stock · Item name, size or SKU. |
| `stock.tab.all · .low · .out` | All · Low stock · Out of stock |
| `stock.col.item · .customers-see · .available · .held · .ordered · .on-hand` | Item · What customers see · Available to customers · In checkouts · Ordered, not shipped · On hand |
| `stock.help.available` | The most one order can contain. Each item in an order comes from one location, so this is the largest amount at any single location. |
| `stock.help.held · .ordered · .on-hand` | Held for customers who are checking out. Holds last up to {minutes} minutes. · Paid orders you haven't marked as shipped. This goes down when you ship them. · What you have counted, at every location. Shipping an order lowers it. |
| `stock.banner.largest` | Customers can order the most you have at one location, because each item in an order comes from one location. |
| `stock.row.not-set · .updated · .refresh · .action.change · .action.history` | Not set (also used for an empty field in C2 and D13; there is no `level.not-set`) · Updated {dateTime} · Refresh · Change stock · History |
| `stock.empty.none · .cta · .low · .out · .search` | You have nothing to stock yet. Add a product first. · Add a product · Nothing is running low. · Nothing is out of stock. · No items match. |
| `stock.setup.title · .body` | We're setting up your stock · This takes a moment after approval. Try again shortly. |
| `level.label.single · .optional-note` | Stock · Leave a field empty if you don't keep stock at that location. |
| `level.context · .min` | In checkouts {held} · Ordered, not shipped {ordered} · Lowest you can set: {minimum} |
| `level.now.in · .low · .out` | Customers now see: In stock · Customers now see: Only {count} left · Customers now see: Out of stock |
| `level.no-change · .saved` | No change. · Saved. |
| `toast.saved · .nothing-changed` | Stock saved. · Nothing changed. |
| `card.title · card.help · card.unavailable · card.locked-offer` | Stock · Enter how many you have at each location. Whole numbers only. · Add stock after you save your offer. · You can add stock while your offer waits for review. |
| `card.action.save · card.status.dirty · card.status.saved` | Save stock · Unsaved stock changes · Stock saved |
| `limit.label · .help · .action.remove · .removed` | Limit per customer (optional) · Leave it empty to use MondaPac's limit: up to {defaultCap}, and fewer when stock is low. · Remove limit · Limit removed. |
| `change.title · .action` | Change stock: {item} · Save stock |
| `locations.title · .intro` | Stock locations · Orders are filled from the first location in this list that has all the units of an item. An item in an order is never split between locations. |
| `locations.how · .example` | How orders are filled · Example: location A has 3 and location B has 5, in that order. A customer orders 4. The order comes from B, because A doesn't have all 4. |
| `locations.badge.default · .default.help · .position` | Default · Your first location. It can't be removed. · Position {n} of {total} |
| `locations.used` | {count} of {max} stock locations used (the limit sentence is `error.sources.limit-reached`; the disabled "Add stock location" uses it too) |
| `locations.action.add · .edit · .earlier · .later · .save-order · .cancel-order` | Add stock location · Edit · Move earlier · Move later · Save order · Cancel |
| `locations.action.earlier-label · .later-label` | Move {name} earlier · Move {name} later |
| `locations.moved · .order.dirty · .order.saved · .new.last` | {name} moved to position {n} of {total}. · Unsaved order · Order saved. · {name} is last in the order. Move it up if orders should come from it first. |
| `locations.remove.help · .zone.value · .zone.shop` | You can't remove a location yet. To stop using one, set its stock to 0. · Time zone: {zoneName} · Your shop's time zone |
| `location.dialog.title.add · .edit` | Add a stock location · Edit {name} |
| `location.label.name · .help.name` | Name · Your own label, for example “Brisbane storeroom”. Customers don't see it. Use a place, not a person's name. |
| `location.label.address · .action.add-address · .help.address · .label.zone · .help.zone` | Address (optional) · Add an address · For your own reference. · Time zone (optional) · Leave it empty to use your shop's time zone. |
| `location.action.add · .save` | Add location · Save location |
| `alert.title · .help` | Low-stock alert · When an item is down to this number or fewer, customers see “Only {count} left” and you see it on your Home page. Set 0 for no alert. |
| `alert.mode.default · .own · .label.number` | MondaPac default ({default}) · My own number · Alert at (0 to 99) |
| `alert.preview · .preview.zero · .help.largest` | Customers will see “Only {count} left” when {count} or fewer can be ordered at once. · With 0, customers never see “Only {count} left” and you get no low-stock alert. · This uses the amount one order can contain: the most at any one location. |
| `alert.applies.next · .applies.now · .saved` | A new number applies to each item the next time its stock changes. · Applies at once. · Low-stock alert saved. |
| `item.back · .section.locations · .section.history` | Back to stock · By location · History |
| `item.col.location · .on-hand · .held · .ordered · .available` | Location · On hand · In checkouts · Ordered, not shipped · Available |
| `item.help.largest` | Your total is {total}, but customers can order {available} at once. Each item in an order comes from one location. |
| `item.limit.value · .none` | Limit per customer: {limit} · No limit of your own |
| `history.col.when · .change · .after · .reason · .by · .location` | When · Change · Level after · Reason · By · Location |
| `history.reason.seller-set · .shipment · .restock · .rekey` | Stock set · Order shipped · Added back to stock · Moved when your product was linked to a shared product |
| `history.by.you · .team · .admin-acting · .system` | You · Team member · MondaPac, signed in as you · MondaPac system |
| `history.empty · .more · .filter.location` | No changes yet. · Show more · Location |
| `home.title · .empty · .more · .out · .error` | Running low · Nothing is running low. · See all low stock · {count, plural, one {# item is out of stock} other {# items are out of stock}} · We couldn't load this card. Try again. |
| `admin.tab · .reveal.title · .reveal.notice · .reveal.action` | Stock · Show this seller's stock · Viewing a seller's stock is recorded. · Show stock |
| `admin.readonly · .viewed · .empty` | Read-only. · Read-only. Viewing this was recorded. · This seller hasn't entered any stock. |
| `admin.by.team · .by.admin-acting · .by.system` | Seller team member · MondaPac admin (acting as the seller) · MondaPac system |
| `view-only.banner` | You can view stock but not change it. Ask your shop owner. |
| `acting-as.banner` | You're signed in as this seller. You can look at stock and locations, but you can't change them. |
| `error.load · .locations.load · .item.load` | We couldn't load your stock. Try again. · We couldn't load your stock locations. Try again. · We couldn't load this item. Try again. |
| `error.quantity.integer · .max` | Enter a whole number, 0 or more. · Enter {max} or less. |
| `error.stock.below-committed (name to confirm)` | You can't set this lower than {minimum}. {held} are held in checkouts and {ordered} are ordered but not shipped. Holds end within {minutes} minutes. |
| `error.conflict.stale.row · .stale.locations` | This stock changed while you were editing. The latest is {onHand}. Check it and save again. · Your stock locations changed somewhere else. We've shown the latest. Check them and try again. |
| `error.conflict.retry` | We couldn't save this just now. Try again. |
| `error.not-found` | We can't find this item. It may have been removed. Reload the page. |
| `error.sources.limit-reached` | You have {max} stock locations. That's the most MondaPac allows. |
| `error.name.required · .name.length` | Enter a name. · Use 1 to {max} characters. |
| `error.limit.range · error.alert.range` | Enter a whole number from 1 to {max}. · Enter a whole number from 0 to 99. |
| `error.acting-as` | This can't be done while you're signed in as the seller. (reuses `access.acting-as-refused`) |
| `availability.in-stock · .low · .out` (B) | In stock · {count, plural, one {Only # left} other {Only # left}} · Out of stock |
| `buyer.summary` (B) | We couldn't hold your items, so none of them are held. Fix the items below and try again. |
| `buyer.error.out · .not-enough · .over-limit · .over-limit.n · .retired` (B) | {item} is out of stock. · We don't have enough of {item} right now. Lower the quantity or remove it. · You can't order that many of {item} at a time. Lower the quantity. · You can order up to {limit} of {item} at a time. · {item} is no longer for sale. Remove it to continue. |
| `buyer.cap.limit` (B) | Limit: {limit} per customer |
| `buyer.error.busy · .unavailable · .throttled` (B) | We couldn't hold your items just now. Try again. · We can't hold your items right now. Try again in a moment. · You've started checkout too many times. Try again in {minutes} minutes. |
| `hold.active · .remaining` (B) | We're holding your items for {minutes} minutes while you check out. · About {minutes, plural, one {# minute} other {# minutes}} left. |
| `hold.ending · .ended` (B) | Your hold ends in about {minutes} minutes. After that your items aren't held, and someone else could buy them. · Your hold ended. Your items aren't held any more. You can still pay if they're still available. |
| `hold.action.again` (B) | Hold my items again |
| `hold.sold-out · .not-charged (L)` (B) | Some items sold out while you were checking out. Review your order. · You haven't been charged. |
| `hold.final · .replaced` (B) | This checkout can't continue. Go back to your cart and start again. · You started another checkout, so this one was replaced. |
| `hold.cancel.title · .body · .action` (B) | Cancel checkout? · We'll stop holding your items. · Cancel checkout |

**Persian terms (from the brief; the fa catalogue translates the keys above and uses these words).** Stock location: منبع موجودی (انبار). In stock: موجود. Out of stock: ناموجود. Only N left: «فقط N عدد مانده». Low-stock alert: آستانهٔ کم‌موجودی. Ordered, not shipped: سفارش‌شده، ارسال‌نشده. Limit per customer: سقف خرید هر مشتری. Hold: نگه‌داشتن (برای ۱۵ دقیقه، از تنظیمات Market). Counts and quantities use the locale's digits through `Intl`.

## 6. Accessibility, responsiveness, RTL and locale

Gate: WCAG 2.2 AA (ID-UX 6).
- **Quantity fields.** Visible label (the location name, or "Stock" with one location); the context line and "Lowest you can set" are linked by `aria-describedby`; `aria-invalid` on error; the error is icon plus text and appears after blur or save, not per keystroke. The unit is never inside the placeholder. Persian digits are accepted (3.0 rule 2).
- **Per-row results.** A save announces once, as `role="status"`: "{n} saved, {m} need attention", and focus moves to the first row with an error. Row saved/no-change states are text, not colour. The error summary is `role="alert"` and takes focus (SL-UX 3.0).
- **Reorder.** "Move earlier" and "Move later" are buttons named with the location ("Move Brisbane storeroom earlier"). After a move, focus stays on the pressed button, which keeps its place in the new order; the new position is announced politely. The first row's "Move earlier" and the last row's "Move later" are disabled with the reason ("Already first").
- **Availability label.** Icon plus words; the Low text contains the number; the colour contrast of Attention and Success on both themes meets 4.5:1 (existing tokens). A change of status after a save is a status message, not an alert.
- **Hold notice.** No countdown, no ticking live region, no ring (a timing and motion hazard). The remaining minutes refresh at most once a minute as plain text; only the 2-minute warning is `role="alert"`, once. **WCAG 2.2.1 (Timing Adjustable): UNRESOLVED. This document does not claim conformance.** The warning is longer than 20 seconds and "Hold my items again" extends the hold, but the account limit (6 holds per 15 minutes, 30 per day, DD 5.4) allows fewer than the ten extensions the criterion asks for. The only route found is the "essential" exception (fair access to scarce stock), which is a security and legal judgement, not a design fact: it needs **Hassan's explicit acceptance** (open point 7). Until he accepts it, or the limits change, the hold is recorded as a known gap against the WCAG 2.2 AA gate.
- **Tables.** S8, S10 and P5/P6 are real tables with column headers; the "What customers see" cell carries its text, not only the icon. Row actions are named "Actions for {item}". Info buttons on the column helps are named "About {column}".
- **Disabled controls** stay focusable and give their reason in text (Add stock location at the limit, Change stock without the key).
- **Dialogs.** As ID-UX: focus trapped and returned; Esc closes; D12 and D13 keep typed text on an outside click.
- **Targets.** 48 px on S8 to S10 and the dialogs on touch widths (the seller works on phone and tablet, IA 4); 32 px on the admin screens with a 24 px hit area for checkboxes. Toasts last at least 6 seconds and never carry the only copy of a result.
- **Widths.** Smallest 320 px for every screen and dialog; frames at 360 and 1280. S8 and P5 show the full table from 760 px; below it each row is a card (name, label, available, "Change stock" menu). C2's `StockRow` switches to Card layout below 760 px with the location fields stacked and full width; the `FormActionBar` is sticky. S9 `LocationRow` stacks; the move buttons stay 48 px. D13 and D12 are sheets below 480 px. S10 is one column at every width.
- **RTL.** Logical properties only. Quantity fields, numbers in tables and the time zone id stay `dir="ltr"` inside an RTL page; location names and addresses use `dir="auto"`; the B10 icon sits at the inline start; "Move earlier/later" use up and down arrows and do not mirror; table column order mirrors. Text may grow 40%: labels wrap, never truncate; the longest strings are the `below-committed` error and the hold banners. No text in images.
- **Locale and Market.** Nothing is hardcoded to AU: hold minutes, defaults, limits and the zone list come from the API (3.0 rule 5). Dates, numbers and plurals come from the user's locale. A Storybook or Playwright case per Market fixture (AU and ZZ, ADR-0003 decision 9) for S8, S9, C2, B10, B12: ZZ uses another hold time and defaults. The tests also assert that no exact number above the threshold appears in any buyer-facing DOM, URL or event payload shown by B10/B11.
- **Telemetry.** Never records stock numbers, location names, addresses, item names, or a customer hold. Page views name the route template only.

## 7. Open points

**Needing the owner or Hadi (not G2 blockers)**
1. **A reason chosen by the seller (Hadi, then the owner).** The ledger's reason list is closed (`seller-set`, `shipment`, `restock`, `re-key`) and has no note column (DM 3.5). The screens record "Stock set" and ask for nothing. If sellers must say why (recount, damaged, received delivery), the reason list changes by migration and the brief's scope reads "adjustments with reasons" differently. Until decided, there is no reason picker.
2. **Low-stock email or notification (Hadi).** The brief gives a dashboard alert only. An email would be E27 and a `notifications` feature (Phase 6).
3. **Delete or archive of a stock location (Hadi).** Not in the brief (DD 12.3). A seller with a mistaken location can rename it and set its stock to 0, nothing more.
4. **Retired items in the seller's view (Hadi, Jafar).** The design hides them (F36). If a seller must see old pending units on a removed size, a "Retired" tab is a small addition.

**For the team**
5. **Acting-as stock edits (Hassan, at the SEL-08 mini-review).** Decided for this draft: S8, S9, S10, C2, D12, D13, the alert card and every write are **read-only** in an acting-as session, refused with `access.acting-as-refused`, the same as `pricing`. They stay read-only until the SEL-08 mini-review adds attribution of the acting admin to inventory changes (DD 6, Hassan 8); only then may writes be opened, and the banner and `history.by.admin-acting` are reviewed with it. The screens make no promise that a change is recorded with anyone's name.
6. **Customer-visible cap (Hassan).** B11 shows the limit only when the API supplies it (seller-set or public rule). Without that field the numberless message is used (API needs 12).
7. **WCAG 2.2.1 for the hold (Hassan, Sajad) - UNRESOLVED.** See section 6 "Hold notice": extensions are limited by the rate limit, so the only route is the "essential" exception, which needs Hassan's explicit acceptance. Nothing here says the hold is conformant. If he rejects it, the account limits (Q-S2) need a second look.
8. **Hold time on the customer page.** The customer has no stored time zone (ADR-0005); the page shows minutes, not a clock time. Hadi decides whether a clock time in the browser's zone is wanted.
9. **"Cancel checkout" (Ali, `ordering`'s G2).** The customer-release use case exists (DD 6); whether the checkout offers the button is `ordering`'s.
10. **Cause of a replaced or final hold on the page (`ordering`'s G2).** B12 `hold.replaced` needs `ordering` to know the cause; otherwise only "Ended" or "Final" are shown.
11. **"You haven't been charged." (legal, `ordering`).** True only if `ordering` commits before it captures payment (Q-A2 input). Not shown until that is decided.
12. **Maximum stock per item (Mohammad).** The database allows a 32-bit integer; the form needs a product maximum (API needs 6).
13. **Addresses and names of locations (Hassan).** Both may be personal data (DM 3.3). The admin view shows names, never addresses. Confirm.
14. **Library numbering (Ali, Jafar).** SL-UX, CUX and CAT-UX plan releases 1.3.0 to 1.8.0, but 1.5.0 to 1.8.3 are already published and 1.1.0 to 1.4.0 are skipped for good (README 9). No document proposes a number: this is a MINOR release named "Inventory", its number is assigned at publish by the design track, and Ali orders the releases. `StatusBadge` is changed here and in "Pricing": one merged change note, built together.
15. **AC numbers in DD.** DD 8 and 9 cite the cap as AC 12, the second Market as AC 13 and the boundary as AC 14; counted in the brief's order they are AC 13, 14 and 15. This spec uses the brief's order. Mohammad corrects DD.
16. **Slice of the admin read (Mohammad).** `inventory.admin-view-seller-stock` is in no slice of brief s11. P5 and P6 are placed after slice 2 here.
17. **IA (Jafar, Reza).** Nav child "Stock" is missing (1.4 change 1); "Stock locations" lives under Catalogue but its route is under `/settings`; the five Market values have no admin screen until ADR-0026.
18. **Offer locked, stock open (Catalog's UX owner).** C2 stays editable while the Offer part is locked (1.4 change 3).
19. **Order behind a "shipped" entry.** The ledger has no order reference (DM 3.5); sellers will ask which order. Decide at `ordering`'s G2 (R1, R2).
20. **Prefix of buyer elements - resolved.** One scheme B for the Phase 4 buyer drafts: `cart` B6 to B9, this spec B10 to B12 (the former CB4 to CB6), `pricing` B13 to B15. A later storefront-wide prefix is Jafar's call before the next buyer module.

### For Jafar
- **Research with real shops.** Do sellers keep more than one location? The design simplifies for one (no location names). Test whether sellers understand "Available to customers" (the largest single location, Q10): the rule makes "Only 8 left" appear for a seller with 24 in total, split 8, 8, 8. The banner on S8 and the help on S10 are my attempt.
- **Phone updates.** Is D13 (one item at a time) enough on a phone, or do sellers need inline edit in S8's table? INV-06 (bulk) is out of scope, so inline edit would be a P1 proposal.
- **The word "In stock" in green.** The brief says only "available/unavailable" and "Only N left". A green "In stock" next to a halal `CertChip` may add noise; the alternative is no label for `IN_STOCK`. I kept the label because the cart needs a positive state.
- **Order of the table columns** and whether "Ordered, not shipped" belongs on S8 before `ordering` exists (Phase 5).

### API needs (for Mohammad)
1. **Stock read** (`get-stock`, seller; `admin-view-seller-stock`): per item and location `onHand`, `held` (active, unexpired), `ordered` (committed), `sellable`, `version`; per item the **live-derived** public status and `onlyLeft`; `holdMinutes`; the Offer's limit. S8's Low and Out tab counts. Confirm that held and ordered are returned (DD 4.5 returns only the minimum in an error).
2. **Not-ready answer** before the approval event has made the seller's inventory (`inventory.not-ready`, name to confirm).
3. **Default location name** at creation (the name is required, 1 to 80; DM 3.3).
4. **Location DTO:** id, name, address (and the descriptor of its fields: the Market's address fields, ideally the same as `sellers`), time zone, `isDefault`, priority, `version`; plus `maxSources` and the count.
5. **Writes:** a batch `set-stock-level` with **per-row** result and the expected `version` per row; the `below-committed` code with `minimum`, `held`, `ordered`; the same-level no-op as a result, not an error; a way to clear the limit per customer.
6. **Maximum on hand** (a Market value or a fixed bound) in the read, for `error.quantity.max`.
7. **Inventory settings read** for sellers: default alert, default limit, line ceiling, `holdMinutes`, `maxSources`.
8. **Threshold:** clear to the Market default; **recompute the public signals of the seller's items when it changes**, or confirm that it applies at the next change (drives `alert.applies.*`).
9. **Ledger read:** per stock item, keyset (DM 3.5); `reason`, signed delta, resulting level, `occurredAt`, actor **kind** and a display name where `identity` can supply one (or only the kind). A seller-wide or item-wide ledger across locations needs another index (Mojtaba); S10 filters by location until then. An order reference on `shipment` entries (open 19).
10. **C3 query and index** (M5): Low and Out items of one seller, newest change first, limited to 5, with counts.
11. **Admin reads:** one audit row per load or per reveal? (S10's paging could make many); the not-found answer for a foreign Market is byte-identical to B5.
12. **Public data for B11/B12:** `getAvailability` or the cart read adds `limit` (seller-set, or the public rule) only when allowed (DD 5.4); the reserve response carries `expiresAt` and the server's current time (or a header) so the page never trusts the device clock; `request.throttled` carries `retryAfterSeconds`.
13. **Catalog join:** S8 needs names, thumbnails, SKU and sizes from `catalog` for sell units that have **no stock row** yet; composed in the BFF or client, never in `inventory` (ADR-0024 decision 5). Keyset order must be the same on both sides.
14. **Code names:** `inventory.not-ready`, `inventory.stock.below-committed`, and use `access.acting-as-refused` (CAT-UX) for every inventory write in an acting-as session (required until the SEL-08 mini-review, open point 5).

## 8. Hand-off notes

### 8.1 Design track: what to build in Figma, in order
Follow `docs/design/figma/update-procedure.md` (Sandbox, review, publish, Export tokens). The release needs the dependent releases first (4, open point 14).
1. **Inventory release (MINOR, number assigned at publish):** `StatusBadge` Availability values and `Style` (one merged change note with the "Pricing" values, built together); `StockRow` (Row, Card, Read; all states, one to four location fields and the wrapped case); `LocationRow` (Row, Card; Default, Moved, Read-only). No token, no icon.
2. **Templates and frames:** `Seller · Stock` (S8: default, every tab, "Not set" rows, empty, setting up, view-only, throttled; 360 px), `Seller · Stock item` (S10: one location and several; history; filter), `Admin · Seller stock item` (P6), S9 on `Shared · Settings` (rows, moved order, at the limit, alert card in default and own-number states, view-only), C2 inside `Seller · Product form` (not available yet, empty, filled, dirty, per-row error of each kind, locked Offer, view-only, acting-as), C3 on `Seller · Home` (with items, empty, error), P5 as a tab of `Admin · Seller detail` (reveal card, table, empty), D12 (add, edit, errors), D13 (desktop and sheet). Buyer frames for B10 (three states, `Style=Text`), B11 (summary plus line messages) and B12 (all states) in a `Templates · Buyer (design-ahead)` section or inside the cart and product frames of the storefront.
3. Each release: README section 8 checklist, both themes, Audit with zero warnings, token export (unchanged), changelog, README counts, `claude/design-status.md`. Owner review: a short Persian summary with screenshots of C2 (the below-committed error), S9 and B12.

### 8.2 Frontend track: which screens wait for which backend slice
Every screen also waits for the frontend foundation (ID-UX D1 and D2 ADRs, slice F0), the identity mini-review that gives the `inventory.*` keys to default roles (brief s11), and the library release of 8.1. Slice numbers are the brief's section 11.
| Screens | Backend slice | Also waits for |
|---|---|---|
| S9 locations part, D12 | 1 | n/a |
| S8 rows, S10, C2 stock fields, D13, "Not set" | 2 | `catalog` slice 7 (Offer form) for C2 and the catalog join (API needs 13) |
| P5, P6 | 2 (admin read; slice to confirm) | `identity` audit writer; P2 from `sellers` slice 6 |
| S9 alert card, B10, C3, S8 Low and Out tabs | 3 | API needs 8 and 10 |
| C2 limit per customer, B11 | 4 | `cart` (messages in the cart) |
| B12 | 4 | `ordering` G2 (checkout page, commit rules) |
| S8 "Ordered, not shipped" real figures, S10 "Order shipped" entries | 5 | `ordering` (Phase 5) |
| Storefront B10 | 3 | Phase 6 storefront |
- Build row menus and every denial from the **allowed-actions list the API supplies**; never infer a permission.
- The panel server sends `x-market-id`. Labels, address fields, zone lists, hold minutes and defaults come from the API. Frontend acceptance includes the ZZ fixture rendering (6).
- A contract test: the buyer-facing DOM and payloads of B10, B11 and B12 contain no exact number above the threshold (AC 8).
- Telemetry rules of 6. Mail: none.
- One frontend PR per row of the table above.

## 9. Review record (2026-10-08)

| Reviewer | Result | What was applied |
|---|---|---|
| Reza (author), 2026-10-08 | Draft | Sections 1 to 8 |
| Jafar (product-designer) | Pending | Open points 1 to 4, 8, 14, 17 and "For Jafar" |
| Mohammad (software-architect) | Pending | API needs 1 to 14; open points 12, 15, 16 |
| Hassan (security-tester), 2026-10-08 | Pass with conditions | Applied: acting-as read-only with `access.acting-as-refused` until the SEL-08 mini-review (F30 step 8, 3.1, open point 5, `acting-as.banner`); location names and addresses inert plain text (3.0 rule 9); WCAG 2.2.1 hold marked unresolved, needs his explicit acceptance (section 6, open point 7). Still his: open points 6, 7, 13 and the exposure table (3.0 rule 3) |
| Sajad (qa-engineer), 2026-10-08 | Pass with conditions | Applied: shared copy keys de-duplicated (`level.not-set`, `locations.limit.reached` removed); wrong "CART-UX 3.2" reference fixed to 3.1.1; buyer IDs renumbered B10 to B12 and the email E27 so test ids are unique across the three documents; the WCAG 2.2.1 gap is not claimed as met |
| Bagher (qc-release-manager), 2026-10-08 | Pass with conditions | Applied: no Figma release number proposed, `StatusBadge` changes merged into one note with "Pricing" (4, 8.1); review-record date added; slot order in "Price and stock" to be confirmed by catalog's UX owner (1.4 item 3); cross-references updated |
| Ali (cto) | Pending | Open points 9, 14, 17 |
| Owner | Pending | Nothing blocks G2; open points 1 to 4 through Hadi |
