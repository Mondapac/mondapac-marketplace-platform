# Restaurants (Eat): screens

**Status:** Draft for review, 2026-11-04 (package R0 of the restaurants plan; ADR-0043, ADR-0044).
**Scope:** which screens the restaurant vertical adds or changes, what each one shows, and which
package builds it. Layout and visual design follow the existing design system; no new component
is drawn here. Buyer pages are multilingual and right-to-left for Persian and Arabic; the seller
and admin panels are English only and left-to-right.

Every screen below is hidden while the `Eat` section is off for the Market (ADR-0043 decision 1).

## 1. Buyer site (`apps/web`, package R7)

| # | Screen | Route | Content and behaviour |
|---|---|---|---|
| B1 | Section switch | header, all pages | `Shop` and `Eat` tabs next to the logo. The account menu, address, language and culture choice stay the same on both. |
| B2 | Eat home | `/eat` | Delivery address bar (shared address book), "Open now" filter, cuisine chips, restaurant cards (name, cuisine, rating, preparation plus delivery time, delivery fee, culture badge, "Closed, order for later today" state). Only restaurants in the buyer's chosen cultures and delivery radius are listed. |
| B3 | Restaurant page | `/eat/r/<slug>` | Header (name, cuisines, rating, opening hours today, certificate badge from `evaluateClaim`), menu sections as a sticky index, item rows with price and "Sold out today". A direct link outside the buyer's cultures shows the page with the warning bar (multi-culture decision Q5). |
| B4 | Item sheet | overlay on B3 | Photo, description, allergen text as entered by the restaurant (no AI wording, R13), modifier groups with "choose 1", "up to 3" and price deltas, quantity, note to kitchen, Add. Add stays disabled until every required group is satisfied. |
| B5 | Eat cart | drawer, `/eat/cart` | Lines from one restaurant. Adding from another restaurant opens a dialog: "Start a new order? Your cart from <restaurant> will be emptied." Delivery or pickup, "As soon as possible" or a time later today (Q7). No tip field (Q6). |
| B6 | Checkout | shared checkout | Same payment, wallet and saved cards as Shop. Shows preparation plus delivery estimate. |
| B7 | Live order | `/account/orders/<id>` | Progress bar: Placed → Accepted → Preparing → Ready → Out for delivery → Delivered (or Ready for pickup with the 4-digit code). Auto-cancel message and refund note if the restaurant does not accept in time. |
| B8 | Order history | `/account/orders` | Existing page with a `Shop / Eat` filter. |
| B9 | Review | existing review flow | Adds two restaurant criteria: food temperature on arrival and order accuracy. |

## 2. Seller panel (`apps/seller`, package R6)

Shown only to a seller account whose business activities include `Restaurant`.

| # | Screen | Content and behaviour |
|---|---|---|
| S1 | Menu | Sections list (drag to reorder) and items per section: name, price, photo, status (Available, Sold out today, Hidden). Bulk "Sold out today". |
| S2 | Menu item editor | Name and description per language (English required), price, photo, allergen text, section, modifier groups (name, min, max, options with price delta), availability. The certification tag is the normal Offer flow; the item never asserts a certification in its text. |
| S3 | Opening hours | Weekly hours (several ranges a day), closed dates, last order time before closing, default preparation time, "Busy" (+15 or +30 minutes, until a chosen time), and a "Closed now" switch also shown in the panel header. |
| S4 | Live orders | Columns New, Preparing, Ready, Picked up. A new order sounds and shows a countdown to the accept deadline; Accept (with preparation time) or Reject (with reason). Mark Ready books the courier. |
| S5 | Order detail | Lines with chosen modifiers and kitchen notes, buyer first name, delivery or pickup code, timeline of sub-states. |

## 3. Admin panel (`apps/admin`, package R8)

| # | Screen | Content and behaviour |
|---|---|---|
| A1 | Settings › Restaurants | `Eat` section on/off (default off), accept deadline in minutes, default delivery radius, restaurant commission rate. Changes are audited. |
| A2 | Live orders | Restaurant orders in progress across the Market, with filters by restaurant and service area and alerts for orders not accepted or late against the preparation time. Read-only in version 1, except cancel with reason. |
| A3 | Sellers | Existing list with a `Shop / Eat` filter. Seller review for a restaurant shows the food business registration fields (pending the legal answer) and the halal certificate when the halal culture is requested. |
| A4 | Catalog › Business activities | Existing page (ADR-0040); the admin adds `Restaurant` and its cuisine tags as data. No code change. |
| A5 | Orders | Existing list with a `Shop / Eat` filter and the sub-state column. |

## 4. States every screen handles

- Section off: buyer routes return not found; panel menu entries are hidden.
- Restaurant closed: B2 and B3 show the next opening time and allow ordering only for later today.
- Item or option sold out: shown greyed with "Sold out today"; it cannot be added.
- Outside the delivery radius: B3 shows pickup only.
- Accept deadline passed: the order is cancelled and refunded; buyer, restaurant and admin see why.

## 5. Open items carried from the plan

Legal and tax questions R-L1 to R-L6 (food business registration, allergens online, food safety
in delivery, alcohol, GST on hot food, tips) wait for a lawyer and an AU tax advisor. Screens A3
and B4 may change after their answers.
