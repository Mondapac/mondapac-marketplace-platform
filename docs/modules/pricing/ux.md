# pricing: flows and screens (G2 UX specification)

| | |
|---|---|
| Author | Reza (ui-ux-designer), 2026-10-08 |
| Status | **Draft for the G2 UX review.** Meets the UI condition of the pricing G2 (DD 11.3: no UI slice before this document and the Figma update). Open points in section 7 are tracked there; only 7.1 items 1 to 3 touch the owner |
| Module | `pricing`, tier A, Phase 4 (ADR-0024). G1 approved by the owner on 2026-10-07; G2 design approved with conditions the same day |
| Reviewers requested | Jafar (product-designer), Hadi (product-owner), Mohammad (software-architect), Hassan (security-tester), Ali (cto) |
| Used for | Brief section 12 (filled in section 4), the Figma work (ADR-0017) and the frontend slices of 8.2 |

**Ground truth.** `docs/modules/pricing/brief.md` (3 to 5, 7, 9, 10, 12); `docs/design/domain/pricing.md` ("DD"; `Q1` to `Q11` are the owner's answers of brief 7 and `owner-answers.md`); `docs/design/data/pricing.md` ("PD"); `docs/design/panels/information-architecture.md` ("IA"); the approved `identity`, `sellers`, `certification` and `catalog` UX specs ("ID-UX", "SL-UX", "CUX", "CAT-UX"), whose shells, templates, components, dialogs, copy rules and acting-as rule are reused and cited; `docs/design/figma/README.md` (library 1.8.3) and `docs/design/tokens/`.

**Not verified.** The Figma file was not opened. The inventory comes from the README, the plugin's `icons.json` (68 icons) and the planned releases of the four earlier specs, **none built beyond 1.8.3**. This document assumes SL-UX's `DataRow`, `FormActionBar`, `Field` Status and `Input` Prefix, CUX's `DateField` and CAT-UX's `tag` icon, and adds one release on top (section 4). Values from Market configuration or pricing's per-Market policy appear as `{names}`; the AU values (AUD, GST, 50%, P7D, 5,000) are examples and never in the frontend. No research with real sellers exists (brief risk 14): the price page and the special-price form are provisional ("For Jafar").

**IDs.** Continue SL-UX (S, P, C, D, E, F). The sibling Phase 4 drafts in the working tree already use **cart: D11, F22 to F28, buyer screens B6 to B9** and **inventory: S8 to S10, P5, P6, C2, C3, D12, D13, F29 to F36, buyer elements B10 to B12**. **Buyer elements use one scheme, B, for the three drafts: this spec takes B13 to B15** (the former CB7 to CB9). **First free numbers used here: S11, P7, C4, D14, E25, F37, B13.** E24 stays SL-UX's unbuilt proposal; inventory's possible low-stock email is E27. D16 is the IA's mobile-navigation decision and is skipped, so the dialogs are **D14, D15, D17, D18, D19**. If a sibling changes, only the ID column changes. CAT-UX and CUX keep their own prefixes. "AC n" is the n-th acceptance criterion of brief 10. Codes are those of DD 5.5 and the platform; the UI maps each to a translation key and **never shows server text** (INTL-11).

## 1. Scope and inventory

Phase 4 UI for `pricing`: **three seller-panel screens, three admin-panel screens (one reserved), three cards, five dialogs, two emails (Phase 6), three buyer-facing elements** (design-ahead), plus slot fills in three CAT-UX screens. Prices live on their own page with an explicit save, never inside the autosaving Offer form (3.0 rule 2). Admin has **no screen that writes a price or shows a regular price, a special price or Cost** outside the hold review (DD 2.3, 5.1).

### 1.1 Screens
| ID | Name | Panel | Route (IA; additions in 1.4) | Slice | AC | Priority |
|---|---|---|---|---|---|---|
| S11 | Prices (regular price per size, specials at a glance) | Seller | `/catalogue/offers/:id/prices` | 1 to 5 | 1 to 6, 9 to 12 | P0 |
| S12 | Special price (one size) | Seller | `/catalogue/offers/:id/prices/:variantId/special` | 5 | 13 to 15, 17, 19 | P0 (Q1) |
| S13 | Price in the products list (fills the "Price" slot of CAT-UX PS1) | Seller | `/catalogue` | 2 | 3 | P0 |
| C4 | Price summary card (slot of PS3 and PS7; top of S11) | Seller | PS3, PS7, S11 | 2, 4, 5 | 3, 16 | P0 |
| C5 | Your cost (private card on S11) | Seller | S11 | 3 | 6, 8 | P0 |
| P7 | Price holds (queue; tab of the Review queue) | Admin | `/review?type=price-hold`, `/catalogue/price-holds` | 4 | 10 to 12, 15 | P0 (Q2) |
| P8 | Review a price change | Admin | `/review/price-holds/:recordId` | 4 | 10, 11, 15, 17, 18 | P0 |
| C6 | Hold comparison card (main column of P8) | Admin | P8 | 4 | 10, 11, 15, 17 | P0 |
| P9 | Price history ("price at date X", VER-09) | Admin | `/catalogue/price-holds/history` | 6 | n/a | P1, **reserved**: rules only |
| B13 | `PriceTag` Card and Page | Buyer, seller, admin | storefront listing and product page, S11, S12, P8 | 2 | 3, 16 | P0 (built Phase 6) |
| B14 | `PriceTag` Line | Buyer | cart line, checkout summary (cart's own UX) | 2 | 3 | P0 (Phase 6) |
| B15 | `PriceTag` No price | Buyer, seller | product page, listing, cart | 2 | 3 | P0 (Phase 6) |

Dialogs: **D14** Approve a price change; **D15** Reject a price change; **D17** Replace the change that's waiting (seller, two uses); **D18** Special price: end, cancel or replace (three uses); **D19** Cancel a waiting price change. SL-UX D9 "Confirm it's you" is **required** before D14 and D15 (`pricing.price-hold.decide` is a protected key; identity R-2 confirms this step-up rule, 7.4 item 5).

### 1.2 Emails
Text templates outside Figma, prefix `pricing.mail.`, layout of ID-UX 3.4. **Both are sent by `notifications` in Phase 6** (DD 14); until then the seller learns a decision only by opening S11 or reading the S13 chips (7.1 item 1). No email carries an amount, Cost or the admin's note (events carry none, DD 6.3).

| ID | Email | Trigger |
|---|---|---|
| E25 | Your price change was approved | `pricing.price-hold-decided.v1`, `approved` (regular or special) |
| E26 | Your price change wasn't accepted, with the words of the reason | The same event, `rejected` |

`superseded` sends nothing. The recipient is an API need (7.3 item 16).

### 1.3 Words
| Word | Means | Never use |
|---|---|---|
| Regular price | The fixed price of one pack when no special runs (قیمت) | "List price", "RRP" |
| Special price | A lower price for a window in the seller's zone (قیمت ویژه) | "Sale", "Discount", "Promotion" (a later module) |
| Customers pay now | The effective price | "Selling price" |
| Your cost | Optional private amount per size; "private" beside it | "Cost price", "Margin", "Profit" |
| Awaiting review | A change MondaPac is checking before it applies (در انتظار بازبینی) | "Held", "Pending", "On hold" (admin tab only: "Price holds", IA) |
| Not accepted | A change MondaPac decided not to apply (SL-UX S7 word) | "Rejected" to a seller (admin buttons say "Reject") |
| No price yet | A size with no valid price (قیمت معتبر ندارد) | "$0", "Free", "N/A", an empty price |
| Pack | One sellable size at a fixed weight or count; the price is per pack | "Per kg" as an input |

### 1.4 Not designed, and why; changes to approved documents
**Not designed.** Bulk edit across Offers, percent changes and price import (INV-06, OFR-10 to 12: out of phase; the only bulk is several sizes of one Offer, F38); price by weight, computed, future-dated, group and tiered prices (Q3 to Q5, CAT-17); any admin screen that sets or fixes a price (DD 2.3); "remove the regular price" (DD 2.3); tax breakdown (`tax`, Phase 5); a seller's record history (P9 is admin-only); bulk approve of holds, a seller-wide price-change page, countdowns and "% off" (brief silent: 7.1, 7.3); margin reports (later, Q7); a threshold editor (configuration as code, brief 11); cart "price changed" notices (cart's UX); AI (DD 12).

**Changes this spec asks of approved documents** (none changes a brief or DD rule; Jafar's acceptance pending):
1. **IA 5.3 "Price, special price and cost (inside the offer form)"** becomes S11 and S12 with C4 in the PS3 and PS7 slot. Reason: the Offer form autosaves (CAT-UX 3.0 rule 3), money and Cost must never be autosaved, and the form's single sticky bar cannot carry a second explicit one.
2. **IA 5.2 "Price hold queue"** gains the detail route and a second entry, **Catalogue → Price holds** (`/catalogue/price-holds`, `pricing.price-hold.view`). Reason: IA 3.1 shows the Review queue only with a decision key, so the Viewer role (view keys only, DD 5.3) would have no route to a screen it may read. CAT-UX solved the same gap with PA3.
3. **CAT-UX PS1, PS3, PS7:** fill the Price column (S13) and the "Price and stock" slot (C4 plus a link; stock is `inventory`'s). `catalog` still imports nothing from `pricing`: the client composes the two reads (ADR-0024 decision 5).
4. **Brief section 12 change log:** "section in the Offer form" becomes "card plus page" (Hadi, 7.1 item 6).
5. **Slot order in "Price and stock".** Catalog's UX owner must confirm the order of the shared slot of PS3 and PS7: the `pricing` summary card (C4) first, `inventory` C2 second.

## 2. Flows

### F37. Set or change the regular price (Seller Owner or Staff with `pricing.price.edit`; brief 4 flows 1 to 3; DD 3.1)
| # | Step | Failure or branch: code and what the user sees |
|---|---|---|
| 1 | The seller opens S11 from C4 ("Edit prices") or the "No price" chip on PS1. One row per sellable size, a not yet published (`proposed`) size included, marked "New": a seller can price before the first publish (DD 5.2) and the page says so | Offer deleted, not the seller's, other Market, size not priceable: B5 "not found", byte-identical (`pricing.offer-not-found`, one answer for every cause). Seller not approved: the limited shell sends the URL to S1 |
| 2 | A size with no price shows "No price yet" and an empty field. The seller types the amount in the Market currency (3.0 rule 3). A changed field shows "About {percent} higher/lower than the current price." as a typing guard (arithmetic on what was typed; never says whether MondaPac will check it) | Local checks on blur: not a number, zero, negative, too many decimals, above the Market maximum (`pricing.amount-out-of-range`: "Enter a price greater than zero and no more than {max}."). The maximum comes from the read |
| 3 | "Save {n} changes" (F38 for several rows). No confirmation for a plain change. Each row carries the series version the page displayed | `conflict.stale`: the row refreshes to the latest and keeps the typed text ("This price was changed somewhere else. The latest price is {current}. Check it and save again."). `conflict.retry`: "Something got in the way. Try again." |
| 4 | **Accepted** (first price, or a change within the limit): the row shows the new price as "Customers pay now" from this moment. Toast "Price saved. Customers pay it from now." | None |
| 5 | **Awaiting review**: a held write is a **success with `status: pending-review`**, never an error (DD 5.5). The row keeps the old price, shows "Awaiting review" with the requested amount beside it (`DataRow` Compare), Toast "Saved. MondaPac will check this price first. Customers keep paying {current} until then." A first price is never held (brief 4 flow 2) | F40 for what follows. No review time, position or reviewer name |
| 6 | **A change is already waiting** and the seller saves another amount: D17 first. Confirm saves; the old record is superseded and the new amount is measured again from scratch. If the typed amount equals the current price, the helper says "This is your current price. Saving it cancels the change that's waiting." and Save opens D19 | Cancel keeps the typed text |
| 7 | **A special runs or is scheduled** and the new regular price is at or below it: `pricing.regular-not-above-special` (Q2), locally and on the server: "This price must be above your special price of {special}. Change or end the special price first." with links to S12 and D18 | A held regular price that conflicts at approval is the admin's case (F42 step 5); the seller then reads "Not accepted" with the reason |
| 8 | Other refusals, each a row message (section 5): `pricing.currency-mismatch` (the Market changed under the page: Attention banner, Reload), `pricing.series-retired`, `pricing.offer-not-found`, seller not approved (banner with link to S1, every control disabled), `request.throttled` (CAT-UX 3.0 rule 11), acting-as (3.7) | Unknown code: `identity.error.unknown`; the row stays editable |

### F38. Several sizes in one save (the only bulk; INV-06 stays P2)
| # | Step | Branch |
|---|---|---|
| 1 | The seller edits any number of rows (an Offer has at most `catalog.maxVariantsPerProduct`, AU 100). Only changed rows are sent | The bar says "{n} unsaved changes", never the amounts |
| 2 | "Save {n} changes" sends **one independent write per row**, one after another, never all-or-nothing (DD 2.3, 9). "Saving {done} of {total}…" is a `role="status"` text | A batch endpoint instead of N calls changes nothing on screen (7.3 item 11) |
| 3 | Result **per row**: Saved, Awaiting review, or its own error. The bar ends with "{saved} saved, {waiting} waiting for review, {failed} not saved." Any failure raises a Critical error summary linking to each failed row | Failed rows keep their text and error; saved rows are not re-sent |
| 4 | `request.throttled` mid-run **stops** the run; unsent rows stay dirty; "Paused: too many requests. {saved} saved. You can continue in {seconds} seconds." with "Continue". No automatic retry | `conflict.stale` on one row does not stop the others |

### F39. Special price: set, replace, end (S12; brief 4 flow 4; DD 3.2; Q1, Q3, Q8)
| # | Step | Branch |
|---|---|---|
| 1 | From a row on S11: "Set special price" (or "Set a new special price"). S12 shows the regular price read-only, the work time zone and the fields Special price, Starts ("Now" or "On a date", radio semantics) and Ends. Times are local date-times in the **seller's work time zone, named**; the zone is read, never typed | No regular price: form disabled, "Set a regular price first." (`pricing.no-regular-price`). Zone missing or provisional: form disabled (3.7, `pricing.seller-zone-unavailable`); the Market zone is **never** offered |
| 2 | A preview (`PriceTag` Special, regular price struck, basis text, "Ends {dateTime}") labelled "Preview", and "About {percent} below your regular price." as a typing guard | Percent from integers, formatted with `Intl`; display only |
| 3 | "Save special price". If a special is running, scheduled or waiting, **D18** (replace) or **D17** (waiting) comes first: one special at a time, a new one replaces the current one (Q3). A running special is not ended before the new one starts, and if the new one needs checking the old one keeps running | There is no "edit the window": the seller sets a new special (DD 3.2) |
| 4 | **Accepted:** Scheduled or Running. Toast "Special price saved." | |
| 5 | **Awaiting review** (the discount from the regular price or from the anchor exceeds the limit; Q8): the special does **not** run; rows read "Awaiting review" and "This special price isn't running yet." The seller is told neither the test nor the limit (7.1 item 4) | The previous special, if any, stays as it is |
| 6 | **End or cancel** (D18): a running special ends now; a scheduled one will not start. Both are `withdraw-special-price` | A **waiting** special has no cancel in the model, only replacement; the button appears only if allowed-actions list it (7.3 item 9) |
| 7 | Refusals: `pricing.special-not-below-regular`, `pricing.special-window.invalid`, `.start-in-past`, `.local-time-invalid`, `pricing.amount-out-of-range`, `pricing.seller-zone-unavailable`, `conflict.stale`, `conflict.retry`, `pricing.series-retired`, `pricing.offer-not-found`, not approved, acting-as, `request.throttled` | Error summary takes focus, each field error linked; values kept |

### F40. Waiting for review: what the seller sees (brief 4 flow 3; Q4; DD 3.1)
| State of a size | What S11, S13 and C4 show | How it ends |
|---|---|---|
| Regular change awaiting review | "Awaiting review", Current beside Requested, "Cancel this change" (D19) | Approved: the requested price applies **from approval, not submission**; "Approved on {dateTime}." shows until the next write for the size. Not accepted: next row. Replaced (D17) or cancelled (D19): disappears |
| Special awaiting review | "Awaiting review", "Isn't running yet" | Approved: runs from the later of its start and the approval. If its end has passed, approval is refused and the admin rejects it (reason `special-window-ended`) |
| Not accepted (regular or special) | "Not accepted", the **reason's words**, and "Note from MondaPac" with the note as plain text when there is one (Q4). The old price stayed in force. Shown until the seller writes again for that size and kind; **no dismissal** (as SL-UX S7) | A new write. The read returns the latest decision per size and kind (7.3 item 4) |
| Closed (Offer deleted, size removed) | The size is gone | System, DD 6.4 |

No page polls: S11, S13 and C4 re-read on load and on focus.

### F41. Your cost: set, change, clear (Seller Owner or a role given `pricing.cost.view`; Q7, Q11; DD 5.2, 6.5)
| # | Step | Branch |
|---|---|---|
| 1 | C5 appears **only** with `pricing.cost.view`. Without it the card is absent, not disabled, and nothing mentions Cost. Cost is optional; empty means "No cost recorded" | Acting-as: a locked line replaces the card (3.7) |
| 2 | Cost is **requested separately** from prices, with its own loading and error states, and **only after "Show costs"**: no Cost request is made when S11 loads. Before that every row says "Hidden" (the page does not know whether a Cost exists). "Hide costs" **discards** the fetched values from memory; showing again requests them again. The choice is not remembered (7.2 item 3). Hiding with unsaved Cost edits asks first (unsaved-changes dialog), because hiding discards them | Read fails: "We couldn't load your costs. Try again." Prices are unaffected |
| 3 | Shown: an amount field per size (3.0 rule 3) and "Clear". Own bar "Save costs". Writing needs `pricing.price.edit` **and** `pricing.cost.view` (DD 5.2, H1): with `cost.view` alone the fields are disabled with the reason | Cost never creates an Awaiting review state |
| 4 | Each row saves independently; a set appends a record, "Clear" appends a "cleared" record. Toast "Costs saved." (no amount); responses are `no-store` | A server validation error carries only path and code: the row says "Enter an amount greater than zero." and keeps the typed text locally; **no value is ever echoed from a response** |
| 5 | Price and Cost are two requests; one can succeed while the other fails and each bar says so (DD 2.3) | |

### F42. Admin: the queue and one decision (Catalogue Moderator, `pricing.price-hold.decide`; DD 3.1, 3.2)
| # | Step | Branch |
|---|---|---|
| 1 | P7 lists waiting changes **oldest first** (fixed; the seller is not told). Each row: product and size, store, kind, direction (Increase or Decrease, icon plus word), requested against current, "about {percent}" | View-only (`price-hold.view`): rows open P8 with every decision control disabled ("Your role can't decide price changes."). Reached from Catalogue → Price holds (1.4 item 2) |
| 2 | "Review" opens P8; C6 shows the request against the **anchor**: "Compared with {anchorAmount}, in effect on {date}", the change as a percent, the limit, and for a special both tests and which one held it, plus the window in the seller's zone. "Applies from approval, not from submission." | Record no longer pending (`pricing.hold.not-pending`): "This change was already decided or replaced." with a link back; no actions |
| 3 | **Approve** opens D14 naming the record the page showed | Refusals on approve stay on the page (3.2a) |
| 4 | **Reject…** opens D15: a required reason from the closed list, an optional note (1 to 1,000 characters) the seller reads | Empty reason: field error, nothing sent |
| 5 | **Approval refused because the regular price no longer fits a special** (`pricing.regular-not-above-special`; brief log): the record stays pending; a Critical banner explains and offers "Reject…" with the reason `regular-not-above-special` preselected. Same for a special whose end passed (`special-window-ended`) | No override is offered |
| 6 | After a decision: Toast ("Price change approved. It applies from now." or "Price change rejected. The seller can see your reason."), then the next waiting item or the empty state. The decision, reason and admin are in the audit log (brief 9) | No email in this phase |
| 7 | **The decider is never the account that submitted** (H4). An admin writes no price, so this arises only in a future acting-as session: both buttons disabled with the reason | Code name: 7.3 item 5 |

### F43. Buyer-facing price (design-ahead; Phase 6; DD 4.1, 6.2)
The storefront draws only what `getEffectivePrices` returns (3.4). Search and notifications consume events that carry **no amount** (DD 6.3), so they read the facade.

## 3. Screen specifications

### 3.0 Rules for every screen
1. **Shells.** S11, S12, S13 use the full seller shell (the catalogue is not in the limited allow-list; a not-approved seller goes to S1). P7 to P9 use the admin shell. Nav: `s_catalogue`; the Review queue item (decision key) and Catalogue → Price holds (view key).
2. **Explicit save, never autosave.** S11, S12 and C5 each have a `FormActionBar` with its own status text. The Offer form's autosave never saves a price or Cost; leaving with unsaved changes asks first. Form state is **in memory only**: no localStorage, sessionStorage, IndexedDB or service-worker cache on S11, S12, C5, P8 or the dialogs; a reload loses unsaved text, saved prices stay. Cost routes and the S11 reads are `Cache-Control: no-store`.
3. **Money fields** reuse SL-UX 3.1a: `Input` with the fixed `Prefix` showing the ISO currency code (never a bare "$"); `type="text"`, `inputmode="decimal"` (`numeric` when the exponent is 0), `autocomplete="off"`, `dir="ltr"`, no `type="number"`. Parsing by the page locale with `Intl` (Latin, Persian and Arabic-Indic digits, the locale's marks); decimals from the currency exponent (`resolvedOptions()`), never "x100". The request carries `{ amount: string of minor units, currency }`, the currency from the Market, never typed; digits only, no sign, no leading zero, at most 16 digits (DD 4.4). Help: "Amount in {currencyCode}{priceBasis}". Saved values display with `Intl.NumberFormat(locale, { style: "currency", currency })`; a symbol and a number are never concatenated. The maximum and exponent arrive with the read.
4. **Market-driven.** Currency, exponent, maximum, `priceBasis`, zone name, threshold and window arrive as data or keys. The frontend has no `AUD`, `GST`, `$`, `50%`, `P7D`, `5,000`. A second Market (ZZ: JPY, exponent 0, tax-exclusive) renders S11, S12, P8 and B13 with no code change.
5. **Never, on any screen:** Cost outside C5 (list, queue, history, toast, banner, error, title, URL, query, log, telemetry, export); an amount in a URL or telemetry event; a price from weight or a "per kg" input; a GST amount; "held", "rejected" (to a seller) or "verified"; a review time, queue position or reviewer name to a seller; the threshold, window W or anchor to a seller (7.1 item 4); another seller's price; a server message string; `$0` or a blank for "No price yet"; a stale number for a failed read.
6. **Permissions** follow SL-UX 3.0 rule 6: no View key, no menu item and B5; View without the action, the control is disabled, stays focusable and gives its reason in text. The panel renders the **allowed-actions list the API supplies**. C5 follows its own key.
7. **Times** that belong to a seller (window, decision, submission) show in the **seller's work time zone, named**, for sellers and admins alike (SL-UX 3.0 rule 8). No raw `Date` arithmetic.
8. **A held write is a success.** The panel never styles `pending-review` as an error and never predicts a hold; the only pre-save hint is arithmetic on what was typed.
9. **Throttling** uses CAT-UX 3.0 rule 11 (`request.throttled` with `retryAfterSeconds`; no automatic retry; the daily limit has no number). **Concurrency:** every write carries the displayed series version; `conflict.stale` refreshes the row and keeps typed text.
10. **Fail closed.** A failed read shows "We couldn't load the prices. Try again." in its own place, never a price, "No price yet" or `0`. An unknown code uses `identity.error.unknown` and leaves the control disabled.

### 3.1 Seller panel
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **S11 Prices.** Set what each size costs customers | Back link "Back to {productName}"; H1 "Prices"; product name and Offer status (read by the client from `catalog`). Info banner: "Each price is for one pack of the size shown. A price that is very different from the current one is checked by MondaPac first. Your current price stays in use until then." **C4**. One `PriceRow` per size: label (from `catalog`; "New" for `proposed`), Regular price field, **Customers pay now** (`PriceTag`), Special price area (state, dates, "Set special price" or "Open special price"), status area. `FormActionBar` "Save {n} changes". Then **C5** when permitted | Regular price per row (3.0 rule 3), local checks on blur, changed rows only (F38). **There is no start-date control for a regular price (AC 5):** a regular price applies from the moment it is accepted, or from approval when it is held; only a special price has a window (S12). Helper lines: typing guard; "Must be above your special price of {amount}." while a special runs or is scheduled; the cancel hint (F37 step 6). Actions: Save, Cancel this change (D19), Set or open special (S12), End special (D18) | Default; **No price yet**; dirty; saving; saved; **Awaiting review** and **Not accepted** with reason and note (F40); special scheduled, running, awaiting review, not accepted; field errors and error summary; `conflict.stale`; `conflict.retry`; Paused by throttle; **view-only** (`price.view` only: read-only fields, "You can view prices but not change them. Ask your shop owner."); **acting-as** and **not eligible** (3.7); size removed; Offer deleted: B5; load error; skeleton rows | Cost outside C5; threshold, anchor, window W; other sellers' prices; stock; tax amount; weight-based controls; queue position |
| **S12 Special price** (one size) | Back link "Back to prices"; H1 "Special price"; size label; "Regular price: {amount}". A **current special card** when one exists: state, amount, window in the seller's zone, "End special price" or "Cancel special price" (D18), "Saving a new special price replaces this one." Form card: Special price (money field); **Starts** (`SegmentedControl` "Now" or "On a date", then a `DateField` with time); **Ends** (`DateField` with time, required); the zone line ("All times are in {zoneName} ({zoneId}). It is now {localTime} there."); **Preview** card; the percent line. Bar "Save special price", "Cancel" | Special price strictly below the regular price. Start: now or not in the past. End required, after the start; no open-ended special. A time that does not exist or occurs twice that day (daylight-saving change) is refused, never shifted. No duration limit (7.2 item 6) | Default; existing special running, scheduled, awaiting review, not accepted; saving; saved; each refusal of F39 step 7; **locked, no regular price**; **locked, zone unavailable** (3.7); view-only; acting-as; not eligible; load error | The Market zone as a substitute; the threshold; a percent-off badge for customers; Cost |
| **S13 Price in the products list** (PS1 Price column) | **"{amount}"** for one size or **"From {amount}"** (the lowest "Customers pay now" among priced sizes, from the batch read), then `Badge` chips: **"No price"** (Attention) when any size has none, **"Special price"** (Success) when one runs, **"Awaiting review"** (Info), **"Not accepted"** (Attention). The cell links to S11. Below 760 px it is the CAT-UX card with the same text | Read-only. One batch read for the page's Offers (at most 200; PS1's page is 50). It fills independently: the list never waits for it | Skeleton in the cell; **failed read**: "Couldn't load" with a "Try again" text action in that cell only; no `price.view` key: the column is absent | A Cost-derived value; a price for a deleted Offer; `0` for a missing price |
| **C4 Price summary card** (PS3, PS7 slot; top of S11) | Title "Price"; "Customers pay now" with `PriceTag` (one size) or "From {amount}" and "{n} of {m} sizes have a price"; chips as S13; link "Edit prices" ("View prices" when view-only) | Read-only; opens S11 | Loading; **no price at all** ("No price yet. Customers can't buy this offer until you set a price." with "Set prices"); load error with "Try again"; view-only; not eligible; draft Offer ("You can set prices before your product is live.") | Cost; stock |
| **C5 Your cost (private)** (card on S11, only with `pricing.cost.view`) | `CardHeader` with `lock`: "Your cost (private)"; help "Optional. Your cost is private. It isn't shown to customers or in price reviews." (L); "Show costs" / "Hide costs" (`eye`, `eye-off`); Cost is fetched only when "Show costs" is pressed and discarded on "Hide costs" (F41 step 2). One row per size (after the reveal): label, amount field, "Clear". Own bar "Save costs" | Greater than zero in the Market currency (3.0 rule 3); empty means none; "Clear" appends a "cleared" record; writing needs `price.edit` as well | Hidden (default); shown; dirty; saving; saved; row error; loading; **load error** (this card only); view-only; **acting-as locked**; no key: absent | A value in any toast, banner, error, title, URL or log; an echoed value; Cost beside a price in S13 or C4; a margin figure |

### 3.2 Admin panel
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **P7 Price holds** (T2; Review queue tab and Catalogue → Price holds) | H1 "Price holds", count, Market name. `FilterChip`s: Kind (Regular price, Special price), Direction (Increase, Decrease). Search (product, store) as a POST body, never in the URL. Columns: Product (`ProductThumb`, name, size label), Store (public name and seller-state `StatusBadge`), Kind, Change ("{requested} instead of {current}", "about {percent}", direction icon plus word), "Re-keyed" `Badge`, In the queue since (admin only), Actions | "Review" (decision key) or "Open" (view key). Fixed order oldest first. **No bulk selection** (7.1 item 5) | Skeleton rows; empty ("No price changes are waiting. You're up to date."); no result ("No price changes match."); load error; throttled; view-only; row being decided ("Decision being recorded"); no view key: B5 | Cost; seller contact data; a reason in a row; AI output as a column or order |
| **P8 Review a price change** (T3, `Admin · Price hold review`) | **Summary bar:** product and size, store and seller-state badge, kind `Badge`, direction, "Submitted {dateTime} {zone}", time in the queue (admin only), "Re-keyed" with old and new size, **Approve** and **Reject…**, and "Applies from approval, not from submission." **Main: C6.** **Side:** store status, the Market's highest price, the limit and directions (policy keys), "Your decision is recorded with your account." A slot for "Earlier changes to this price" (P9 rows, only with `price-history.view`, P1) | **Approve** (D14), **Reject…** (D15) from allowed-actions; a disabled button states why beside it. Refusals after a click stay on the page (3.2a) | Pending; loading; **not pending any more**; **series retired**; each refusal of 3.2a; decision under way; view-only; stale; throttled; load error; no view key: B5 | Cost; price history (P9 only); any AI recommendation or "looks fine" |
| **C6 Hold comparison card** (`DataRow` Compare) | **Requested** (`PriceTag`); **Compared with** the anchor amount and "in effect on {date}"; **Change** "about {percent} higher/lower. The limit is {limit} up or down." with a flag; **Customers pay now**. A **special** adds: **Regular price now**, **Discount from the regular price**, **Discount from the anchor**, "Held because the discount from {the regular price or the anchor} is more than the limit.", **Window** "Starts {dateTime}, ends {dateTime} ({zoneName})". Fixed line: "The anchor is the later of the price in effect {window} ago and the last approved price." | Read-only. Percentages arrive exact (fraction or basis points) and are formatted with `Intl`; no floating-point maths on money | As P8 | The seller's Cost; seller identity beyond the store name |
| **P9 Price history** (VER-09, P1, **reserved**) | Not detailed until scheduled. Fixed rules: key `pricing.price-history.view`; one row per record (kind, amount, status, effective period, decision, reason code); "price at date X" is a date field in the seller's zone; **no Cost, ever** | List shape and query: 7.3 item 12 | Reserved | Cost |

**3.2a P8 refusals.**
| Code | What P8 shows | Action left |
|---|---|---|
| `pricing.hold.not-pending` | Info "This change was already decided or replaced." and a link to the queue | None |
| `pricing.regular-not-above-special` | Critical "This price can't be approved. It isn't above the seller's special price of {special} ({window})." Record stays pending | Approve disabled; **Reject…** with `regular-not-above-special` preselected |
| `pricing.special-window.ended` | Critical "This special price ended before it could be approved." | Approve disabled; Reject… with `special-window-ended` |
| `pricing.amount-out-of-range` (policy now) | Critical "This price is outside the allowed range now ({max}), so it can't be approved." | Approve disabled; Reject… |
| `pricing.series-retired` | Info "The offer or size was removed, so this change has closed." | None |
| Same-decider (name open) | Disabled buttons, "You submitted this change, so someone else has to decide it." | None |
| `conflict.stale`, `request.throttled`, `access.permission-missing`, unknown | Page refreshes and says what changed; CAT-UX rule 11; "Your role can't decide price changes."; `identity.error.unknown` | As the new state allows |

### 3.3 Seller-facing states
Icon plus word, never colour alone (`StatusBadge` for states, `Badge` for flags). Persian terms are the brief's; legal reads final wording (L).

| State | Badge word | Persian | Tone, icon | Where | Text beside it |
|---|---|---|---|---|---|
| No valid price | No price yet | قیمت معتبر ندارد | Attention, `alert-circle` | S11, S13, C4, B15 | "Customers can't buy this size until you set a price." |
| Awaiting review | Awaiting review | در انتظار بازبینی | Info, `clock` | S11, S12, S13, C4 | Regular: "MondaPac is checking {requested}. Customers pay {current} until it's decided." Special: "MondaPac is checking this special price. It isn't running yet." No time promised |
| Not accepted | Not accepted | none in the brief | Attention, `alert-circle` | S11, S12, S13 | The reason's words, then "Note from MondaPac" and the note |
| Special scheduled | Scheduled | | Info, `calendar` | S11, S12 | "Starts {dateTime} {zone}." |
| Special running | Special price | قیمت ویژه | Success, `tag` (fallback `zap`) | S11, S12, S13, B13 | "Until {dateTime} {zone}." |
| Approved (text line) | none | | | S11 | "Approved on {dateTime}." until the next write |

**Reason codes (closed list; Q4; Jafar writes the wording, J1).** Two codes are required by the flow and exist whatever else the list holds: `regular-not-above-special` and `special-window-ended`. These four are **drafts for Jafar**, not decided: `looks-like-a-typing-mistake`, `change-too-large`, `discount-too-large`, `other`. Words are Market keys `pricing.reason.<code>`; the seller sees the words, never the code. The note is admin-authored plain text (1 to 1,000 characters), shown inert with `dir="auto"` and line breaks kept.

### 3.4 Buyer-facing elements (design-ahead; built in Phase 6)
One library component, `PriceTag` (section 4). Rules for every place a price is drawn:
| Element | Content and rules |
|---|---|
| **B13 Card and Page** | **Regular:** the amount (`Intl`, Market currency) at `heading/amount` (Page) or `heading/stat` (Card), then the basis text for the returned `taxInclusive` flag: when true, the **one Market key `market.price.tax-inclusive`** (AU "including GST"; section 5), used as `{priceBasis}` inside the sentence; when false, or when the Market has no tax convention, no basis text. **Special:** `Badge` "Special price"; the special amount large; the regular price struck through, **preceded by the word "Was"**; "Ends {dateTime}" in small text when `specialEndsAt` exists. Strikethrough is never the only signal (brief 9). No percent off, no "Save $X", no countdown (7.1 item 2). The amount is `unitPrice` and nothing else: the storefront never computes a price |
| **B14 Line** | The single price component for every cart and checkout line (it is in `cart`'s component list, with no cart-specific price block or strings): unit amount, for a special the struck "Was {amount}" in small text and "Ends {dateTime}", then the basis text. Cart's spec decides quantities, totals and change notices |
| **B15 No price** | "No price yet" instead of an amount; the buy button disabled with its reason as text ("This size can't be bought until the seller sets a price."). The Offer is still shown (G1 `catalog`). Never `0`, never blank |
| **Read failure** | State Unavailable: "Price unavailable. Try again." with a text action and the buy button disabled; no cached or earlier amount |
| **"Ends" zone** | `specialEndsAt` is an instant; the proposal is the seller's work zone, named (7.1 item 3) |
| **Per-kg line** | Not designed (7.1 item 7). A pack's weight sits in the size label from `catalog` |

### 3.5 Dialogs
SL-UX 3.4 and ID-UX 3.3 rules apply: title names the action and object; destructive confirms open with focus on Cancel; sheet layout below 480 px; focus trap and return; no outside-click close while text is typed.
| ID | Title and body | Fields and notes |
|---|---|---|
| **D14 Approve** (admin) | "Approve this price change?" Regular: "{product}, {size}: customers will pay {requested} from now instead of {current}. The seller will see the result in their panel." Special: "…the special price {requested} will run from {start} until {end} ({zone})." (start passed: "from now until {end}") | Names the record the page showed. **D9 comes first (required).** No email promised |
| **D15 Reject** (admin) | "Reject this price change?" Required `Select` "Reason for the seller" (closed list; the chosen reason's words shown read-only); optional `Textarea` "Note for the seller" (counter 1,000, plain text) with "The seller will read this. Don't include personal details or internal notes." "Reject change" | Empty reason: field error, nothing sent. **D9 comes first (required).** Text survives an outside click |
| **D17 Replace the change that's waiting?** (seller, two uses) | Regular: "You have a price change waiting for review: {waiting}. Saving {new} replaces it and it's checked again. Customers keep paying {current} until a change is approved." Special: "You have a special price waiting for review. Saving a new one replaces it, and it's checked again." | Shown when the read says one waits; the server handles a race silently (DD 3.1). Cancel keeps the typed text |
| **D18 Special price: end, cancel or replace** (seller, three uses) | **End:** "End this special price now?" "Customers pay the regular price of {regular} again from now." **Cancel:** "Cancel this special price?" "It won't start." **Replace:** "Replace your special price?" "Your current special price of {current} stops when the new one starts. If the new one needs checking, the current one keeps running until it's decided." | End and Cancel focus "Keep it". Opener disabled in acting-as |
| **D19 Cancel a waiting price change** (seller) | "Cancel this price change?" "The change is dropped. Customers keep paying {current}." "Cancel change" / "Keep waiting" | Sends the current price (DD 3.1 b); never says "save". Focus "Keep waiting" |

### 3.6 Fail-closed, acting-as and refusal states
| Situation | What the surface does |
|---|---|
| **Seller not approved or not eligible** (DD 5.2 "deny"; code name open, 7.3 item 3) | Every price control disabled and focusable; Attention banner "Your seller account can't change prices right now. See your seller account." linking to S1; reads that work stay visible; the same banner on C4 |
| **Work time zone missing or provisional** (`pricing.seller-zone-unavailable`; AC 19) | S12 disabled with "Special prices aren't available yet because your work time zone isn't confirmed. Contact us." S11's "Set special price" is disabled with the same reason as text. The Market zone is never offered. Edge state: an approved seller normally has a zone; an admin zone correction fixes it (SL-UX D8) |
| **Acting-as** | SEL-08 has not decided if prices may be touched, so price, special and Cost writes **and Cost reads** are refused (DD 5.4; Hassan finding 6). S11 and S12 show the permanent acting-as banner (IA 3.3), read-only fields and every write control disabled with "Prices and costs can't be changed while you're signed in as the seller." **C5 becomes a locked line** "Costs aren't available while you're signed in as the seller." and no Cost is requested. No AI element |
| **Offer deleted, size removed, other seller or Market** | B5 on the page; a row disappears on the next read; the write answer is the one `pricing.offer-not-found`, never hinting the cause |
| **Allowed-actions cannot load** | Save and decision buttons absent with "We couldn't check what you can do. Try again." |
| **Cost read fails** | That card only (F41 step 2) |
| **System closed a pending change** | Nothing to show; the row is gone |
Session ended mid-form: the person returns to the same page after sign-in; unsaved text is not kept (3.0 rule 2). Empty and loading copy: skeleton rows (3 on S11, 8 on P7), "No price changes are waiting. You're up to date." (P7), "No cost recorded." (C5).

## 4. Design-system impact (fills brief section 12)

"Existing" is README section 5 (library **1.8.3**) and `icons.json`. "Planned, not built" are SL-UX `DataRow`, `FormActionBar`, `Field` Status, `Input` Prefix; CUX `DateField`; CAT-UX `tag`. Their release numbers are stale (README 9: 1.1.0 to 1.4.0 are never used, 1.5.0 to 1.8.3 are taken), so the earlier six planned releases must be renumbered; this document does not do it. All changes below are additive: **one MINOR release, named "Pricing"**. **This document proposes no number:** the number is assigned at publish by the design track, and Ali orders the releases (the earlier six, inventory and cart sit beside it). **`StatusBadge` is changed by both this release and "Inventory"** (`docs/modules/inventory/ux.md` section 4): the two changes are merged into one change note and built together.

| Screen element | Existing or planned | Change needed in Figma first | Release |
|---|---|---|---|
| Price and special price for buyers, sellers and admins | None | **New component `PriceTag`**: Size Card, Page, Line; State Regular, Special, No price, Unavailable, Loading; slots Amount, Was amount (struck), Basis text, Ends line, `Badge`. Light and dark; RTL (`bdi`). Used on S11, S12, S13, C4, C6 and the storefront and cart | MINOR "Pricing" |
| Price rows | `TableCell`, `Input` (+ Prefix), `StatusBadge`, `Button` | **New component `PriceRow`**: Layout Row or Card (below 760 px); slots Size label, Regular price field, Customers pay now (`PriceTag`), Special area, Status area, Actions; State Default, No price, Dirty, Saving, Saved, Awaiting review, Not accepted, Error, Read-only; Mode Cost (one field, no `PriceTag`) for C5. Used on S11 (reached from PS3 and PS7) and C5 | MINOR "Pricing" |
| Date and time of a window | `DateField` (CUX plan) | New BOOLEAN `Show time`: time part beside the date, 12 or 24 hour by locale, labelled text segments with `inputmode="numeric"`, no wheel or clock; the error State names the invalid part | MINOR "Pricing" |
| Status words of 3.3 | `StatusBadge` | Add Scheduled and Special price, No price yet; Awaiting review and Not accepted are reused from SL-UX | MINOR "Pricing" |
| Struck "Was" price | Typography tokens (no strikethrough) | **Two text styles** `body/default-struck`, `body/small-struck` (13.5 and 12.5 px, line-through), exported to `typography.json`; colour `text/muted`, contrast confirmed by the Audit on both themes | MINOR "Pricing" |
| Request against anchor | `DataRow` Compare (SL-UX) | None; frames for each row kind of C6 | n/a |
| Money entry, save bars | `Input` Prefix, `Field`, `FormActionBar` | None. Usage notes: ISO code and basis text in amount fields; a **Paused** text state on the bar (F38) | n/a |
| Cost show or hide | `Button`, `IconButton` | None; `eye`, `eye-off`, `lock` exist | n/a |
| Queue and review | `Tab`, `FilterChip`, `TableCell`, `ProductThumb`, `StatusBadge`, `Badge`, `ReasonQuote` | None | n/a |
| Dialogs and banners | `Dialog`, `Select`, `Textarea`, `Toast`, `InfoBanner` (1.8.0) | None; a frame per dialog use | n/a |
| Icons | 68 (`calendar`, `clock`, `lock`, `eye`, `eye-off`, `arrow-up`, `arrow-down`, `alert-circle`, among them) | None new; `tag` comes from CAT-UX | n/a |
| Templates | Seller `Home`; planned `Seller · Store profile`, `Seller · Products`; Admin `Sellers`; planned `Admin · Revision review` | New: `Seller · Prices` (S11, S12), `Admin · Price holds` (P7, from `Admin · Sellers`), `Admin · Price hold review` (P8). Updated frames: PS1 Price column, PS3 and PS7 slot | MINOR "Pricing" |
| Mobile navigation | `NavDrawer`, `BottomTabBar` (1.5.0) | Built; 360 px frames use it | n/a |

- **Brief 12's "components not in README"** are covered: price and special display (`PriceTag`), hold status in the seller panel (StatusBadge values, `PriceRow`, C4), the review page (T3 plus C6), form states and date-time entry (`DateField`, `FormActionBar`), no-permission page (B5).
- **New components (2):** `PriceTag`, `PriceRow`. **Changed (2):** `DateField`, `StatusBadge`. **New text styles (2).** **New tokens, icons: none.** **New templates (3)** plus two updated frames.
- **Semver:** MINOR; nothing renamed or removed. Light and dark; Audit clean; `typography.json` exported; README counts and changelog updated by the design track.

## 5. Copy

Keys are `pricing.<surface>.<element>[.<variant>]`, kebab-case, ICU MessageFormat, en-AU spelling. Errors are `pricing.error.<code>`; platform codes (`conflict.*`, `validation.failed`) have `pricing.error.*` aliases of the CAT-UX wording; **throttling uses the shared keys `error.request.throttled.retry` and `error.limit.daily` (CAT-UX, SL-UX; the same two as `inventory`), with no `pricing.` copy**; unknown codes use `identity.error.unknown`. Market values are keys the Market owns (`{priceBasis}`, `{currencyCode}`, the reason list). Amounts are formatted by code. (L) marks legal review. Persian is written by a person from these keys; until then the Market's default locale is used, never half a sentence.

| Key (prefix `pricing.`) | en-AU text |
|---|---|
| `prices.title · back · intro` | Prices · Back to {productName} · Each price is for one pack of the size shown. We don't price by weight. |
| `prices.review-note · before-live` | A price that is very different from the current one is checked by MondaPac first. Your current price stays in use until then. · You can set prices before your product is live. |
| `prices.basis` | Amount in {currencyCode}{priceBasis, select, none {} other {, {priceBasis}}} |
| `prices.col.size · regular · now · special · status` | Size · Regular price · Customers pay now · Special price · Status |
| `prices.row.label (sr) · new-size · none · none-help` | Regular price for {sizeLabel} · New · No price yet · Customers can't buy this size until you set a price. |
| `prices.row.change · must-exceed-special · cancel-hint` | About {percent} {direction, select, up {higher} other {lower}} than the current price. · Must be above your special price of {amount}. · This is your current price. Saving it cancels the change that's waiting. |
| `prices.action.save · saving · paused · continue` | Save {count, plural, one {# change} other {# changes}} · Saving {done} of {total}… · Paused: too many requests. {saved} saved. You can continue in {seconds} seconds. · Continue |
| `prices.status.saved · dirty · summary` | Saved · Unsaved changes · {saved} saved, {waiting} waiting for review, {failed} not saved. |
| `prices.toast.saved · waiting` | Price saved. Customers pay it from now. · Saved. MondaPac will check this price first. Customers keep paying {current} until then. |
| `prices.state.awaiting · body-regular · body-special` | Awaiting review · MondaPac is checking {requested}. Customers pay {current} until it's decided. · MondaPac is checking this special price. It isn't running yet. |
| `prices.state.not-accepted · reason-title · note-label · approved-on` | Not accepted · Why it wasn't accepted · Note from MondaPac · Approved on {dateTime}. |
| `prices.state.scheduled · running · scheduled-line · running-line` | Scheduled · Special price · Starts {dateTime} {zone}. · Until {dateTime} {zone}. |
| `prices.change.current · requested` | Current · Requested |
| `prices.action.set-special · new-special · open-special · end-special · cancel-special · cancel-change` | Set special price · Set a new special price · Open special price · End special price · Cancel special price · Cancel this change |
| `prices.view-only` | You can view prices but not change them. Ask your shop owner. |
| `summary.title · now · from · count · edit · view · set` | Price · Customers pay now · From {amount} · {priced} of {total} sizes have a price · Edit prices · View prices · Set prices |
| `summary.none` | No price yet. Customers can't buy this offer until you set a price. |
| `list.chip.none · special · awaiting · not-accepted · load-failed` | No price · Special price · Awaiting review · Not accepted · Couldn't load |
| `special.title · regular-line · replace-note` | Special price · Regular price: {amount} · Saving a new special price replaces this one. |
| `special.label.price · starts · ends · starts-now · starts-date` | Special price · Starts · Ends · Now · On a date |
| `special.zone · preview · percent · save` | All times are in {zoneName} ({zoneId}). It is now {localTime} there. · Preview · About {percent} below your regular price. · Save special price |
| `special.toast.saved · ended · cancelled · waiting-help` | Special price saved. · Special price ended. · Special price cancelled. · This special price isn't running yet. |
| `cost.title · help (L) · show · hide · hidden` | Your cost (private) · Optional. Your cost is private. It isn't shown to customers or in price reviews. · Show costs · Hide costs · Hidden |
| `cost.label · none · clear · save · toast.saved` | Cost for {sizeLabel} · No cost recorded. · Clear · Save costs · Costs saved. |
| `cost.error.amount · load · need-edit · acting-as` | Enter an amount greater than zero. · We couldn't load your costs. Try again. · You need permission to change prices to change costs. · Costs aren't available while you're signed in as the seller. |
| `error.offer-not-found · series-retired · currency-mismatch` | We couldn't find this size. Reload the page. · This size was removed, so its price can't change. · This amount isn't in {currencyCode}. Reload the page and try again. |
| `error.amount-out-of-range · no-regular-price` | Enter a price greater than zero and no more than {max}. · Set a regular price first. |
| `error.special-not-below-regular · regular-not-above-special` | Enter a special price below your regular price of {regular}. · This price must be above your special price of {special}. Change or end the special price first. |
| `error.special-window.invalid · start-in-past · local-time-invalid` | The end must be after the start. · The start can't be in the past. · That time doesn't exist, or happens twice, on that date because of daylight saving. Choose another time. |
| `error.seller-zone-unavailable · not-eligible · acting-as` | Special prices aren't available yet because your work time zone isn't confirmed. Contact us. · Your seller account can't change prices right now. See your seller account. · Prices and costs can't be changed while you're signed in as the seller. |
| `error.conflict.stale · conflict.retry` | This price was changed somewhere else. The latest price is {current}. Check it and save again. · Something got in the way. Try again. |
| `error.load · actions-unavailable` | We couldn't load the prices. Try again. · We couldn't check what you can do. Try again. |
| Throttling (shared, not redefined here) | `error.request.throttled.retry` (with `retryAfterSeconds`) and `error.limit.daily` (no retry), per CAT-UX 3.0 rule 11 |
| `dialog.replace.title · body-regular · body-special · action` | Replace the change that's waiting? · You have a price change waiting for review: {waiting}. Saving {new} replaces it and it's checked again. Customers keep paying {current} until a change is approved. · You have a special price waiting for review. Saving a new one replaces it, and it's checked again. · Replace |
| `dialog.special.end · cancel · replace (title · body · action)` | End this special price now? · Customers pay the regular price of {regular} again from now. · End special price / Cancel this special price? · It won't start. · Cancel special price / Replace your special price? · Your current special price of {current} stops when the new one starts. If the new one needs checking, the current one keeps running until it's decided. · Replace |
| `dialog.keep-special · keep-waiting` | Keep it · Keep waiting |
| `dialog.cancel-change.title · body · action` | Cancel this price change? · The change is dropped. Customers keep paying {current}. · Cancel change |
| `admin.holds.title · tab · nav` | Price holds (all three) |
| `admin.holds.filter.kind · direction · regular · special · up · down` | Kind · Direction · Regular price · Special price · Increase · Decrease |
| `admin.holds.col.product · store · kind · change · since` | Product · Store · Kind · Change · In the queue since |
| `admin.holds.change · rekeyed · search · no-result · empty` | {requested} instead of {current}, about {percent} · Re-keyed · Search price changes · No price changes match. · No price changes are waiting. You're up to date. |
| `admin.holds.view-only · busy` | Your role can't decide price changes. · Decision being recorded |
| `admin.review.title · submitted · queue · applies-from · rekeyed · audit` | Review a price change · Submitted {dateTime} {zone} · In the queue for {duration} · Applies from approval, not from submission. · Re-keyed from {oldSize} to {newSize}. · Your decision is recorded with your account. |
| `admin.compare.requested · anchor · change · now` | Requested · Compared with {anchorAmount}, in effect on {date} · About {percent} {direction, select, up {higher} other {lower}}. The limit is {limit}{directions, select, both { up or down} up { up} other { down}}. · Customers pay now |
| `admin.compare.regular · discount-regular · discount-anchor · window` | Regular price now · Discount from the regular price · Discount from the anchor · Starts {start}, ends {end} ({zone}) |
| `admin.compare.held-by · anchor-note · limits.max` | Held because the discount from {basis, select, regular {the regular price} other {the anchor}} is more than the limit. · The anchor is the later of the price in effect {window} ago and the last approved price. · Highest allowed price: {max} |
| `admin.refuse.not-pending · retired · same-decider` | This change was already decided or replaced. · The offer or size was removed, so this change has closed. · You submitted this change, so someone else has to decide it. |
| `admin.refuse.regular-not-above-special · window-ended · out-of-range` | This price can't be approved. It isn't above the seller's special price of {special} ({window}). · This special price ended before it could be approved. · This price is outside the allowed range now ({max}), so it can't be approved. |
| `admin.action.approve · reject · review · open` | Approve · Reject… · Review · Open |
| `admin.approve.title · body-regular · body-special · body-special-now` | Approve this price change? · {product}, {size}: customers will pay {requested} from now instead of {current}. The seller will see the result in their panel. · {product}, {size}: the special price {requested} will run from {start} until {end} ({zone}). · {product}, {size}: the special price {requested} will run from now until {end} ({zone}). |
| `admin.reject.title · reason · note · note-help · action` | Reject this price change? · Reason for the seller · Note for the seller (optional) · The seller will read this. Don't include personal details or internal notes. · Reject change |
| `admin.toast.approved · rejected` | Price change approved. It applies from now. · Price change rejected. The seller can see your reason. |
| `admin.history.title · date (P1)` | Price history · Price on {date} |
| `reason.regular-not-above-special · special-window-ended` | This price is not above your special price. Change or end the special price first, then set the price again. · This special price ended before we could review it. Set a new one if you still want it. |
| `reason.looks-like-a-typing-mistake · change-too-large · discount-too-large · other (drafts for Jafar)` | The price looks like a typing mistake. Check the amount and set it again. · This change is larger than we can accept without more information. Contact us if the price is correct. · The discount is larger than we can accept without more information. Contact us if it is correct. · See the note from MondaPac. |
| `buyer.price.special-label · was · ends` | Special price · Was {amount} · Ends {dateTime} |
| `buyer.price.none · none-reason · unavailable · retry` | No price yet · This size can't be bought until the seller sets a price. · Price unavailable. Try again. · Try again |
| `buyer.price.sr.regular · sr.special` | {amount}{priceBasis, select, none {} other {, {priceBasis}}} · Special price {amount}, was {was}{priceBasis, select, none {} other {, {priceBasis}}}{ends, select, none {} other {, ends {ends}}} |

**One basis key for all three Phase 4 documents:** `{priceBasis}` is the text of the Market-configuration key `market.price.tax-inclusive`, used when the returned `taxInclusive` flag is true (AU: "including GST"); `none` for a Market with no convention or a false flag. It is always a parameter inside a sentence (`prices.basis`, `buyer.price.sr.*`, `PriceTag`'s basis text, `cart.price-basis`, `cart.group.below-minimum`), never a separate suffix key, so translators can reorder it. There is no separate "Includes GST" label. The frontend has no "GST".

Emails (prefix `pricing.mail.`; each has `.subject`, `.heading`, `.body`, `.action`; account-type and ignore lines from `identity.mail.common`; Phase 6):
| Template | Subject | Body | Button |
|---|---|---|---|
| `price-approved` (E25) | Your price change was approved | "A price change for {productName} was approved." No amount | Open your prices |
| `price-not-accepted` (E26, L) | Your price change wasn't accepted | "A price change for {productName} wasn't accepted. {reasonWords} The price customers pay hasn't changed. Any note is on your prices page." No amount, no note | Open your prices |

## 6. Accessibility, responsiveness, RTL and locale

Gate: WCAG 2.2 AA (ID-UX 6; the brief names 2.1 AA as its minimum).
- **Forms.** A real `<form>` per card (S11, C5, S12) with Enter to save; visible labels; a price field's name is "Regular price for {sizeLabel}", with basis help and error linked by `aria-describedby` and `aria-invalid` on error; the currency prefix joins the name through the help, not announced twice. The error summary (`role="alert"`) takes focus and links to each failed row. 3.3.7: nothing already given is asked again.
- **Price list.** S11 is a `table` with column headers on desktop and cards with the size as heading on phones. Row results are `role="status"`, once per result; "Saving {done} of {total}" announces at most every few seconds. Focus stays on Save after a save; after a failed batch it moves to the error summary.
- **`PriceTag`.** One accessible name from `buyer.price.sr.*` ("Special price $8.00, was $10.00, including GST, ends 31 Oct 2026, 11:59 pm AEST"). The struck amount is `<s>` with the visible word "Was"; strikethrough never carries meaning alone (brief 9). No countdown, so nothing animates or re-announces.
- **Date and time.** Segmented text inputs with visible labels and `inputmode="numeric"`, 12 or 24 hour by locale, no wheel or clock face; the zone line is part of the description; the error names the invalid part; Persian and Arabic-Indic digits are accepted.
- **Cost.** "Show costs" is a toggle (`aria-pressed`) naming its effect; hidden rows say "Hidden" in text, never a row of dots; the lock icon is `aria-hidden` and the heading says "private"; no Cost value is placed in a live region, toast or title.
- **Disabled controls** stay focusable with their reason as text beside them (view-only, not eligible, acting-as, zone unavailable, same decider).
- **Dialogs.** As ID-UX; D15 and D17 keep typed text on an outside click; D18 End and Cancel and D19 open on the safe button.
- **Queue and review.** P7 is a table from 760 px with "Actions for {product}" menu buttons; direction is icon plus word; C6 is a description list or table with headers "Requested", "Compared with", "Result".
- **Motion and targets.** "Saving" is a static icon plus text under `prefers-reduced-motion`; toasts last at least 6 seconds and never carry the only copy of a reason. 48 px on seller pages (Touch density); 32 px on admin screens with a 24 px hit area for checkboxes and menu buttons.
- **Widths.** Smallest width 320 px for S11 to S13, C4, C5 and every dialog; frames at 360 and 1280. S11 and S12 are phone-first: one column, `PriceRow` as cards, a sticky `FormActionBar` with a full-width primary button, C5 below the prices, the preview above the Save bar. S13 is the CAT-UX card below 760 px. P7 is a table from 760 px and stacked cards below, with no bulk selection. P8 is two columns from 1024 px; below that the side column drops under the main and Approve and Reject repeat in a sticky bottom bar below 760 px. All use the mobile navigation of IA 4.
- **RTL.** Logical properties only. Amounts, percentages and the currency prefix stay left-to-right (`bdi`, `dir="ltr"`) inside an RTL page, in the page locale's digits and currency pattern; "Was" sits before the special amount in reading order, not on a fixed side; direction is carried by words and vertical `arrow-up` and `arrow-down`, which do not mirror; back chevrons mirror. Free text (note, size labels) uses `dir="auto"`. Text may grow 40%: buttons, chips and `PriceRow` cells wrap, never truncate. No text in images.
- **Locale and Market.** Nothing is hardcoded to AU, GST or AUD (3.0 rule 4). Dates, numbers, plurals and percentages use `Intl` in the user's locale; decimals follow the currency exponent. The ZZ fixture (JPY, exponent 0, tax-exclusive, other threshold and maximum) must render S11, S12, P8 and B13 with no code change: a Storybook or Playwright case per Market fixture (ADR-0003 decision 9). The special-price field is tested on the ADR-0005 zone fixtures: Brisbane, Sydney (daylight saving), Adelaide (half-hour offset plus daylight saving), Perth, and a transition day with a nonexistent and a repeated local time.
- **Claims.** No screen or email states or implies a certification. "Approved" is never a badge on a price.

## 7. Open points

### 7.1 Needs the owner, Hadi or legal
1. **Seller notification before the first sale.** Decisions are emailed only in Phase 6 (DD 14; brief risk 5). Until then the seller finds out by opening S11 or reading S13. For a small Brisbane launch this may do; if not, E25 and E26 move earlier or Home gets an attention card. Hadi with the owner. The spec works either way.
2. **Reference-price display (L).** B13 shows the regular price struck beside a special with the word "Was". Whether and how an Australian "was" price may be shown (how long it must have been charged, the wording) is a consumer-law question for counsel. Also open: a percent off or "Save $X" (not designed: derived figures add rounding and legal risk) and whether to show "Ends {date}". The design works if the struck price and the end line are dropped.
3. **Time zone of the "Ends" line on the storefront.** The facade returns an instant. Proposal: the seller's work zone, named; alternative: the buyer's own zone. Needs the zone in the answer or from `sellers` (7.3 item 10).
4. **Does the seller see the limit?** The spec shows sellers **no number**: not the threshold, window W, anchor or which test held a special. A visible "50%" lets a seller stay just under it; the anchor limits that, but it is a security and product call (Hassan, Hadi). **Hiding the threshold from sellers is a design choice, not a security control:** the control is the anchor and the server-side checks, which hold whether or not the seller can see the number. If shown, only `prices.review-note` and the Awaiting review body change.
5. **Bulk decisions for holds.** Not designed: the brief has none, each decision concerns one amount, and the queue is small at launch (brief risk 5). Hadi: is a bulk reject wanted before a second city?
6. **Brief section 12 change-log row** for "card plus page" (1.4 item 4). Hadi.
7. **Unit price (L).** A "per kg or per 100 g" line is not designed (fixed price per pack; brief silent). Whether Australian unit-pricing rules reach a marketplace seller is a legal question; if so, the pack weight from `catalog` plus a computed line becomes a new element.

### 7.2 For Jafar
1. **Reason codes (J1):** the list is closed and the wording is yours (Q4). Two codes are required by the flow; four drafts are in 3.3. Should the note be mandatory for `other`?
2. **Wording to confirm:** "No price yet" (the brief's Persian is «قیمت معتبر ندارد»); "Customers pay now"; "Awaiting review" for a price change; "Not accepted" with "Note from MondaPac"; the replace and end dialogs; Persian for every key.
3. **Masked Cost (proposal).** C5 hides amounts until "Show costs", requests Cost only at that moment, discards it on "Hide costs" and forgets the choice, because a shop screen is seen by staff and customers and Cost is the one value ADR-0024 treats as secret. Cost: one tap. Please test whether owners resent it.
4. **Layout to test (provisional):** prices on their own page with C5 below, not inside the long Offer form; the special price on a separate page, not inline; whether a grid is too heavy for an Offer with 3 sizes; whether the "about {percent}" guard helps or alarms.
5. **Cost higher than price** is neither blocked nor flagged (no rule). A non-blocking note would put Cost beside the price; not designed.
6. **No duration limit** on a special (the brief gives none): five years is accepted. Say if a soft warning is wanted.
7. **IA:** accept the second admin entry and the route additions (1.4 items 1 and 2).

### 7.3 API needs (for Mohammad)
1. **Seller read `pricing.view-offer-pricing`**, per size: current regular (amount, record id, series version); effective (`unitPrice`, `basis`, `specialEndsAt`, `taxInclusive`); current or scheduled special (amount, instants, zone, status); the **waiting** record (kind, amount, submitted instant); the **latest decision per size and kind** (outcome, reason code, note, instant) until the next write; `no-valid-price` as an explicit state; limits (`max`, currency, exponent) and the `priceBasis` key; allowed flags with denial codes (edit, set special, cancel, set cost). Batch form for PS1 (at most 200 Offers).
2. **Write answers:** `status: accepted | pending-review`, record id, new series version; the codes of DD 5.5 plus `conflict.*`, `request.throttled`, `request.daily-limit-reached`.
3. **Two codes DD does not name:** the refusal for a seller not approved or eligible (DD 5.2 says "deny") and for acting-as (CAT-UX uses `access.acting-as-refused`). The spec uses `pricing.error.not-eligible` and `pricing.error.acting-as` until named.
4. **Latest rejection:** the read returns only the latest decided record per size and kind, as SL-UX S7 does; confirm.
5. **Same-decider refusal (H4):** the code, and whether allowed-actions on P8 carry it so the buttons can be disabled before the click.
6. **P8 read:** record, kind, direction, anchor (amount, record id, "in effect on" date), the **exact change** (fraction or basis points, not a float), the limit and directions as exact decimals and keys, the window as a duration, the regular price at submission and the effective price now, for a special both discounts and which one held it, window instants and zone, submitted instant, `reKeyed` with old and new size, product, size and store names composed from the `catalog` and `sellers` facades; allowed-actions with the approval hints (`regular-not-above-special`, `special-window.ended`, `amount-out-of-range`, `series-retired`, same-decider).
7. **Queue list:** `pricing.list-price-holds` with filters (kind, direction), search by product and store (POST), oldest-first pagination, a count for the nav badge, and access by `price-hold.view` (1.4 item 2).
8. **Reason list and note:** the closed list with keys from Market configuration; note 1 to 1,000 characters (DD M6), returned to the seller as plain text.
9. **Waiting special:** may the seller cancel it without replacing? The model names no such transition (DD 3.2). Offered only if the API says so.
10. **Buyer "Ends" zone:** `specialEndsZone` in the facade answer, or confirmation that the storefront takes it from `sellers` (7.1 item 3).
11. **Several sizes:** N independent calls (as designed) or one batch use case with per-row results; either gives the same screen. If N calls, state the per-account rate limit so the Paused state is sized, and confirm that ordinary refusals do not trip the `offer-write-refused` throttle for a normal seller (DD 5.2, M7).
12. **P9 history:** list shape, the "price at date X" query, key `pricing.price-history.view`.
13. **Cost routes:** `{ amount, currency }` or none, set and clear, `no-store`, `details` with path and code only, the version for stale writes, allowed flags (write needs `price.edit` and `cost.view`).
14. **Cost upper bound:** the brief fixes only "greater than zero, in the Market currency" and the safe integer. Confirm what the field enforces.
15. **S12 read:** the seller's work zone (IANA id from the approved revision) and a special-availability flag with the reason (`zone-unavailable`, `no-regular-price`, `not-eligible`).
16. **E25 and E26 recipient:** the submitting account or the Seller Owner; events carry no actor (DD 6.3), so `notifications` needs a lookup (Phase 6).
17. **A seller-wide "price changes" list** does not exist in DD 5.2; S13's chips cover it for now. Say if a list use case is wanted.

### 7.4 For Hassan
1. **Cost on screen:** in-memory only, `no-store`, never echoed from a response, never in a toast, title, URL, log or telemetry, absent without the key, masked by default (7.2 item 3), locked in acting-as. Confirm this covers the front end's share of ADR-0024 decision 2, and that "never shown in price reviews" (C5 help, L) is a claim you accept.
2. **Telemetry** carries only the screen id, the outcome kind and the error code: no amount, Cost, note or product text.
3. **Showing the limit** (7.1 item 4). Not showing it is not a control; the anchor and the server checks are.
4. **N calls for one save** (7.3 item 11): sequential, stopping at the first throttle, is my proposed client behaviour.
5. **D9 before D14 and D15 is required** (protected key `pricing.price-hold.decide`): identity R-2 confirms it is its step-up rule, not a pricing rule; the screens do not offer a decision without it.

### 7.5 Proposals I took that the team may overturn
A separate price page and summary card (1.4 item 1); Cost masked by default; the "about {percent}" guard (display only); emails without amount or note; no limit shown to sellers; sequential independent writes for several sizes; a second admin entry for view-only roles.

## 8. Hand-off notes

### 8.1 Design track: what to build in Figma, in order
Follow `docs/design/figma/update-procedure.md`. The release needs SL-UX's `DataRow`, `FormActionBar`, `Input` Prefix and `Field` Status, CUX's `DateField` and CAT-UX's `tag` built first.
1. **Release "Pricing" (MINOR, number assigned at publish; `StatusBadge` built together with the "Inventory" values from one merged change note):** text styles `body/default-struck` and `body/small-struck`; `DateField` Show time; `StatusBadge` values; `PriceTag` (every size and state, light and dark, en and fa/RTL); `PriceRow` (Row, Card, Cost mode, every state). Templates `Seller · Prices` (S11: default, no price, dirty, saving, saved, awaiting review, not accepted, special scheduled, running, awaiting, not accepted, view-only, acting-as with C5 locked, not eligible, Paused, load error; S12: default with preview, existing special, each refusal, daylight-saving error, zone unavailable, no regular price, view-only; C5 hidden, shown, row errors, absent), `Admin · Price holds` (P7: filters, empty, no result, view-only, busy row, cards at 360) and `Admin · Price hold review` (P8 with C6 for regular up, regular down, special by regular, special by anchor, re-keyed, each refusal of 3.2a, view-only, decided). Updated frames: PS1 Price column, PS3 and PS7 slot. Dialog frames D14, D15, D17, D18, D19 with each use. Buyer frames for B13 to B15 on listing card, product page and cart line, with and without a tax basis, and in the ZZ fixture.
2. Each release: README section 8 checklist, both themes, Audit with zero warnings, token export, changelog, README counts, `claude/design-status.md`. Owner review: a short Persian summary with screenshots of S11 (awaiting review), S12, P8 and B13.

### 8.2 Frontend track: which screens wait for which backend slice
Every screen also waits for ID-UX D1 and D2 ADRs, slice F0 (ADR-0017), CAT-UX's PS1, PS3 and PS7 and the Figma release. Slices are brief section 11.

| Screens | Backend slice | Library release |
|---|---|---|
| S11 regular-price rows (first price, limits, `conflict.stale`, F37, F38), C4 without chips | 1 | "Pricing" |
| S13, C4 effective price, B13 to B15, `PriceTag` | 2 | "Pricing" |
| C5, F41 | 3 | "Pricing" |
| Awaiting review and Not accepted on S11, S12, S13, C4; D17, D19; P7, P8, C6, D14, D15; E25, E26 (Phase 6) | 4 | "Pricing" |
| S12, D18, specials on S11, S13, C4, zone refusals | 5 (needs `sellers` zone and the boundary job) | "Pricing" |
| P9 | 6 (P1) | later |

- Build every button, menu and denial from the **allowed-actions list the API supplies**; never infer a permission, predict a hold or compute a price.
- Money is parsed and formatted with `Intl` and the currency exponent; no `$`, `AUD` or `GST` in code. Tests for AU and ZZ on S11, S12, P8 and B13. The panel server sends `x-market-id`.
- Telemetry per 7.4 item 2; Cost responses `no-store`; a log-redaction check covers the Cost DTO (DD 6.5).
- Mail templates are built by `notifications` from the `pricing.mail.*` keys (Phase 6).
- Slices 1, 3, 4 and 5 need Hassan's review before merge (ADR-0024; DD 13); each UI slice follows the backend slice it reads.

## 9. Review record (2026-10-08)

| Reviewer | Result | What was applied |
|---|---|---|
| Jafar (product-designer) | Pending | 7.2 |
| Hadi (product-owner) | Pending | 7.1 |
| Mohammad (software-architect) | Pending | 7.3 |
| Hassan (security-tester), 2026-10-08 | Pass with conditions | Applied: Cost fetched only after "Show costs" and discarded on "Hide costs" (F41 step 2, C5); D9 step-up required for `pricing.price-hold.decide`, identity R-2 confirms (1.1, 3.5, 7.4 item 5); hiding the threshold stated as not a control (7.1 item 4, 7.4 item 3). Still his: 7.4 |
| Sajad (qa-engineer), 2026-10-08 | Pass with conditions | Applied: no start-date control for a regular price (AC 5) stated on S11; throttle keys aligned with the shared `error.request.throttled.retry` and `error.limit.daily`; one tax-inclusive basis key `market.price.tax-inclusive`; buyer IDs B13 to B15 unique across the three documents |
| Bagher (qc-release-manager), 2026-10-08 | Pass with conditions | Applied: no Figma release number proposed, `StatusBadge` changes merged with "Inventory" (4, 8.1); `PriceTag` named as the single price component, including cart lines (3.4 B14); "Price and stock" slot order for catalog's UX owner to confirm (1.4 item 5); review record dated |
| Ali (cto) | Pending; release order decided 2026-10-08 (Ali): Seller admin (1.10.0), Certificates and badge, Catalogue seller, Certification admin, Pricing, Inventory, Catalogue admin, then Cart. Pricing cannot go first: it needs `DateField` and the `tag` icon, and its seller screens sit inside catalog frames PS1, PS3 and PS7, which are not built. Cart waits for the storefront shell decision and `ordering`'s G2. Source: claude/design-status.md | 1.4, 4 |
| Owner | Pending | 7.1 items 1 to 3 |
