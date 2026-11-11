# Multi-culture: screens

**Status:** Draft for review, 2026-11-11 (package 0 of the multi-culture plan; ADR-0047).
**Scope:** the screens the feature adds or changes, what each shows, and which package builds it.
Layout and visuals follow the existing design system; panel screens use the templates T1 to T9 of
`docs/design/panels/information-architecture.md` and the components of
`docs/design/frontend-kickoff.md`. No new component is drawn here. Buyer pages are multilingual and
right-to-left for Persian and Arabic; the admin and seller panels are English only and
left-to-right. Quoted strings are English source keys. Every buyer screen below exists only while
the Multi-culture switch is on (ADR-0047 decision 2); with it off the site looks as it does today.

## 1. Buyer site (`apps/web`, package 6)

| # | Screen | Route | Content and behaviour |
|---|---|---|---|
| B1 | Culture chooser | dialog on first visit; header button always | One card per Active culture: name, one-line description, checkbox. At least one culture must stay selected, with the message "Choose at least one culture". Save stores the choice (guest cookie, or profile when signed in). Text states that the choice only filters what is shown. Dialog is focus-trapped, closes with Esc, and its first focus is the first card. At 375 px it is a full-height sheet with a sticky Save bar; each card is a 48 px target. |
| B2 | Outside-your-choice bar | top of the product page, and of a seller page when it applies | Shown on a direct link to a product outside the chosen cultures: "This product belongs to <culture>, which is not in your view." Button "Add this culture to my view". Add to cart is disabled with the reason beside it until the culture is added. The bar is `role="status"`, not colour only. |
| B3 | Header and cards | all pages | Header button shows the chosen cultures (count when more than one) and opens B1. Product cards carry a small culture badge; the existing certificate seal is unchanged. |
| B4 | Search hint | search results | Zero or few results in the chosen cultures but results elsewhere: one line "12 results in <culture>" with "Add". Products from the other culture are never shown. |
| B5 | Culture landing page | `/c/<code>` | Indexed by search engines; shows the culture name, description and its shelves, consistent with the slogan "a market for all cultures". |
| B6 | Cart and checkout | existing pages | Lines show their culture. A line whose culture the buyer removed carries "Removed from your view" and needs confirmation before payment. Checkout says "This order arrives in 2 separate deliveries" and shows each delivery's fee before Pay (package 7). |
| B7 | Fixed halal text | footer, "Become a seller", assistant quick buttons | Built from culture data instead of fixed text (ADR-0047 decision 11). |

## 2. Admin panel (`apps/admin`, package 5)

| # | Screen | Template | Content and behaviour |
|---|---|---|---|
| A1 | Catalog › Cultures | T2 Index, T6 Form | List: name, code, status, order, required certificate, sellers, products. Add or edit form: code (fixed after creation), names per locale chosen from a language dropdown (English required, a locale publishes only when complete), required certificate type, badge, status, order. A culture is deleted only with no sellers; otherwise made Inactive. The default culture cannot be made Inactive. |
| A2 | Settings › Storefront › Multi-culture | T7 Settings (`SettingRow`) | Switch (default off), default cultures for a guest with no choice, "Show the chooser on first visit". Turning on checks the preconditions (two Active cultures, each with an approved seller), shows the effect, asks confirmation and is audited. Turning off says nothing is deleted. |
| A3 | Catalog › Categories, column "Cultures" | existing table | Restrict a branch to chosen cultures; for a certified culture mark it "Certification required" or "Neutral". Children inherit from the parent unless changed. |
| A4 | Report "Hidden in the halal view" | T2 Index | Products hidden because their category needs a certificate and the claim is not allowed, each with a link to its category. |
| A5 | Sellers › Review, section "Cultures" | existing review | Approve or reject each membership request, with a reason. |

## 3. Seller panel (`apps/seller`, package 5)

| # | Screen | Template | Content and behaviour |
|---|---|---|---|
| S1 | Store profile › Cultures | T6 Form | The seller's cultures and the status of each (requested, approved, rejected with reason); request another; changes are change requests. |
| S2 | Product list label | existing table | A product hidden in a certified culture shows "Hidden in the halal view: this category needs a certificate" with the reason. |

## 4. Accessibility and states
- Every control has a text label; status is never shown by colour alone.
- B1 and B2 are keyboard operable; changes of view are announced politely.
- States to design per screen before build: empty (no culture selected, no results), loading,
  error (choice could not be saved: keep the dialog open and say so), and the switch-off state.
- Persian and Arabic render B1 to B7 right to left; culture names fall back to English when a
  locale is not published.

## 5. Open before build
Wording of B1, B2 and B4 is reviewed by the UI/UX owner and, for the legal points L1 to L3 of the
plan, by the legal team before the buyer package starts.
