# Restaurants (Eat): screens

**Status:** Draft for review, 2026-11-04 (package R0 of the restaurants plan; ADR-0043, ADR-0044).
**Scope:** which screens the restaurant vertical adds or changes, what each one shows, and which
package builds it. Layout and visual design follow the existing design system; panel screens use
the templates T1 to T9 of `docs/design/panels/information-architecture.md` and the components of
`docs/design/frontend-kickoff.md`. No new component is drawn here. Buyer pages are multilingual
and right-to-left for Persian and Arabic; the seller and admin panels are English only and
left-to-right. Quoted strings are English source keys; the fa and ar catalogues translate them.

Every screen below is hidden while the `Eat` section is off for the Market (ADR-0043 decision 1).

## 1. Buyer site (`apps/web`, package R7)

| # | Screen | Route | Content and behaviour |
|---|---|---|---|
| B1 | Section switch | header, all pages | `Shop` and `Eat` tabs next to the logo. The account menu, address, language and culture choice stay the same on both. At 375 px the tabs sit in a row under the header bar, full width. |
| B2 | Eat home | `/eat` | Delivery address bar (shared address book), "Open now" filter, cuisine chips, restaurant cards (name, cuisine, rating, preparation plus delivery time including any "Busy" extra time, delivery fee, culture badge, "Closed, order for later today" state). Only restaurants in the buyer's chosen cultures are listed. Restaurants that deliver to the address come first; restaurants outside the delivery range follow with a "Pickup only" label (owner, 4 Nov). |
| B3 | Restaurant page | `/eat/r/<slug>` | Header (name, cuisines, rating, opening hours today, "Busy" extra time when set, certificate badge from `evaluateClaim`), menu sections as a sticky index (horizontal scrolling chips at 375 px), item rows with price and "Sold out today". A direct link outside the buyer's cultures shows the page with the warning bar (multi-culture decision Q5). |
| B4 | Item sheet | overlay on B3 | Photo, description, allergen text as entered by the restaurant (no AI wording, R13), modifier groups with "Choose 1" and "Up to 3" (ICU plurals) and price deltas, quantity, note to kitchen, Add. Add stays disabled until every required group is satisfied, and the unmet group is named next to it. At 375 px: a full-height bottom sheet with a sticky Add bar that shows the line total. Each option row is a 48 px target across the whole row. |
| B5 | Eat cart | drawer on desktop, full page at 375 px, `/eat/cart` | Lines from one restaurant with their chosen options. Adding from another restaurant opens a dialog: "Start a new order? Your cart from <restaurant> will be emptied." Buttons "Empty cart and add" and "Keep my cart". Delivery or pickup, "As soon as possible" or a time later today (Q7). No tip field (Q6). |
| B6 | Checkout | shared checkout | Same payment, wallet and saved cards as Shop. Shows preparation plus delivery estimate. Text under Pay: "Your card is charged when the restaurant accepts your order." (ADR-0044 decision 5). |
| B7 | Live order | `/account/orders/<id>` | Progress steps with text labels: Waiting for the restaurant (with the time left to accept), Accepted, Preparing, Ready, Out for delivery, Delivered (or Ready for pickup with the 4-digit code). The current step has `aria-current="step"`; status changes are announced politely. States: rejected by the restaurant (with its reason), not accepted in time, running late against the estimate. On reject or timeout: "Your card was not charged." If the card cannot be charged after the restaurant accepts: "We could not charge your card, so your order was cancelled." |
| B8 | Order history | `/account/orders` | Existing page with an "All / Shop / Eat" `SegmentedControl`, All by default. |
| B9 | Review | existing review flow | Adds two restaurant criteria: food temperature on arrival and order accuracy. |

## 2. Seller panel (`apps/seller`, package R6)

Shown only to a seller account whose business activity is `Restaurant`.

| # | Screen | Template | Content and behaviour |
|---|---|---|---|
| S1 | Menu | T2 Index | Sections list and items per section: name, price, photo, status (Available, Sold out today, Hidden). Reorder by drag and by "Move up" / "Move down" in each row's menu (keyboard, WCAG 2.1.1). Bulk "Sold out today". |
| S2 | Menu item editor | T6 Form | Price, photo, section, modifier groups (min, max, options with price delta), availability. Text fields per language: item name and description, section names, modifier group names, option names and allergen text. English is required; other languages are chosen from a language dropdown, not one tab per language. Save is blocked while an English field is empty, with the T6 error summary. The certification tag is the normal Offer flow; the item never asserts a certification in its text. |
| S3 | Opening hours | T6 Form | Weekly hours (several ranges a day), closed dates, last order time before closing, default preparation time, "Busy" (+15 or +30 minutes, until a chosen time), and "Closed now". |
| S4 | Live orders | T4 Board | Reuses `OrderBoard`, `OrderCard` and `CountdownRing` with the existing columns Needs action, Preparing and Ready for pickup; collected and delivered orders leave the board. A new order goes to Needs action as an urgent card with a countdown to the accept deadline; Accept (with preparation time) or Reject (with reason). Mark ready books the courier. If the card cannot be charged after Accept, the card leaves the board with an icon and the text "Order cancelled: payment failed". "Taking orders" `Switch` (the "Closed now" setting of S3) at the top of the board; turning it off asks for confirmation: "New orders stop now. Orders you have accepted are not affected." At 375 px the columns become a `SegmentedControl`. |
| S5 | Order detail | T3 Detail | Lines with chosen options and kitchen notes, buyer first name, delivery or pickup code, timeline of sub-states. |

Navigation config rows (seller panel): `menu` (Menu, `/menu`), `hours` (Opening hours,
`/settings/hours`) and `live-orders` (Live orders, `/orders/live`, badge: orders in Needs action),
each shown only with the `Restaurant` activity and the seller's catalog or order permission keys
that package R6 names. On the phone bottom bar, Live orders replaces Orders for a restaurant.

### S4 accessibility

- The countdown uses `role="timer"` with `aria-live="off"`; only threshold crossings are
  announced. The deadline is also shown as text: "Accept by 12:41".
- A new order is announced with `aria-live="polite"`.
- Sound always comes with a visible cue (urgent card and badge count) and can be switched off.
  Browsers block sound until the user interacts, so the first time the board opens it shows an
  "Enable sound" prompt; until it is pressed, a banner says sound is off.
- The accept deadline is a real-time event, the exception of WCAG 2.2.1, so it cannot be
  extended by the user.
- Status is never shown by colour alone: each column, card state and alert has text and an icon.

## 3. Admin panel (`apps/admin`, package R8)

| # | Screen | Template | Content and behaviour |
|---|---|---|---|
| A1 | Settings › Restaurants | T7 Settings (`SettingRow`) | `Eat` section on/off (default off), accept deadline in minutes, default delivery radius (designed in R5). Switching off asks for confirmation: "New restaurant orders stop and Eat carts are locked. Orders already placed continue to delivery." Changes are audited. |
| A2 | Live orders | T2 Index | Restaurant orders in progress across the Market, with filters by restaurant and service area and alerts (icon and text) for orders not accepted or late against the preparation time. Read-only in version 1, except cancel with reason. |
| A3 | Sellers | T2 Index, T3 Detail | Existing list with an "All / Shop / Eat" filter. Seller review for a restaurant shows the food business registration fields (pending the legal answer), the halal certificate when the halal culture is requested, the restaurant's delivery radius, and a "Commission rate" step: the admin sets the seller's rate (COM-02) as part of approving a restaurant. |
| A4 | Catalog › Business activities | existing | Existing page (ADR-0040); the admin adds `Restaurant` and its cuisine tags as data. No code change. |
| A5 | Orders | T2 Index | Existing list with an "All / Shop / Eat" filter and the sub-state column. |

## 4. States every screen handles

- Section off: buyer routes return not found; panel menu entries are hidden. Placed orders stay
  visible in B7, B8, S4, S5, A2 and A5 until they end.
- Loading: B2 and B3 show skeletons. Fetch error: a message with Retry (T9 on panel routes).
- B2 with no address yet: ask for an address before listing; until then show restaurants for
  pickup only.
- B2 with no restaurants for the address, or none for the chosen filters: `EmptyState` with a
  way to change the address or clear filters.
- Restaurant closed: B2 and B3 show the next opening time and allow ordering only for later
  today. After the last order time, with no slot left today: "Opens tomorrow 11:00" and no
  ordering.
- Item or option sold out: shown with "Sold out today" and cannot be added. Sold-out rows keep
  text contrast of at least 4.5:1 (no opacity fade). A whole menu sold out: B3 says so and
  shows the next opening time. A required group whose options are all sold out makes the item
  unavailable.
- Between cart and payment (B5, B6): the restaurant closes, an item sells out, a price changes
  or the address leaves the delivery range. Checkout stops, names the line or reason, and
  offers to remove the line, change the time or switch to pickup.
- Outside the delivery range: B2 and B3 show pickup only.
- Rejected or accept deadline passed: the order is cancelled and the card authorisation is
  released; buyer, restaurant and admin see why.

## 5. Right-to-left

- The progress steps of B7 and the sticky index of B3 mirror in Persian and Arabic.
- Prices, signed price deltas ("+$2.00") and the 4-digit pickup code are isolated with `<bdi>`
  or `dir="ltr"`. Screen readers read the pickup code digit by digit.

## 6. Open items carried from the plan

Legal and tax questions R-L1 to R-L6 (food business registration, allergens online, food safety
in delivery, alcohol, GST on hot food, tips) wait for a lawyer and an AU tax advisor. Screens A3
and B4 may change after their answers.
