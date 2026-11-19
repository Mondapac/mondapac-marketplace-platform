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
| A2 | Settings › Multi-culture (settings store, ADR-0042) | T7 Settings (`SettingRow`) | Switch (default off), default cultures for a guest with no choice, "Show the chooser on first visit". Turning on checks the preconditions (two Active cultures, each with an approved seller; when one fails the page names it and links to where it is fixed), shows the effect (Offers and sellers shown or hidden per culture), asks confirmation and is audited. Turning off says nothing is deleted. |
| A3 | Catalog › Categories, column "Cultures" | existing table | Restrict a branch to chosen cultures; for a certified culture mark it "Certification required" or "Neutral". Children inherit from the parent unless changed. |
| A4 | Report "Hidden in the <culture> view" | T2 Index | Products hidden because their category needs a certificate and the claim is not allowed, each with a link to its category. |
| A5 | Sellers › Review, section "Cultures" | existing review | Approve or reject each membership request, with a reason. |

## 3. Seller panel (`apps/seller`, package 5)

| # | Screen | Template | Content and behaviour |
|---|---|---|---|
| S1 | Store profile › Cultures | T6 Form | The seller's cultures and the status of each (requested, approved, rejected with reason); request another; changes are change requests. |
| S2 | Product list label | existing table | A product hidden in a certified culture shows "Hidden in the <culture> view: this category needs a certificate" (the culture name comes from data, not from code) with the reason. |

## 4. States, accessibility and right-to-left

### States

| Screen                              | Loading                | Empty                                                                                                        | Error                                                                                                    |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| B1 chooser                          | skeleton cards         | no Active culture: the dialog is not shown                                                                   | Save fails: dialog stays open, inline "We could not save your choice. Try again." with Retry             |
| B2 bar                              | none                   | none                                                                                                         | adding the culture fails: the bar stays with a Retry button                                              |
| B4 search hint                      | none                   | no hit anywhere: the normal empty search page, no hint                                                       | hint omitted                                                                                             |
| B5 landing page                     | skeleton shelves       | no visible products: "Nothing here yet" and a link to the home page                                          | T9 error page with Retry                                                                                 |
| Home, categories, shelves, sellers  | existing skeletons     | a category or shelf with no products in the chosen cultures is hidden, not shown empty                       | existing error states                                                                                    |
| A1, A4                              | table skeleton         | A1 "No cultures yet" with the Add button; A4 "No hidden products"                                            | T9 error with Retry                                                                                      |
| A5, S1                              | section skeleton       | S1 "No culture yet. Request one."                                                                            | inline error with Retry                                                                                  |

Switch off: `/c/<code>` returns not found; B1 to B7 are not rendered; A1, A3 (column), A4, A5 and S1
are hidden from navigation and routes.

### Behaviour not covered above

- Filtering applies to the home page, categories, shelves, slides, seller list and "others also
  bought" (B3 covers only header and cards). A category with no products in the chosen cultures is
  hidden.
- When a guest signs in or signs up, the cookie choice moves to the profile; if the profile already
  has a choice the buyer is asked once which to keep.
- Closing B1 with Esc without saving applies the default cultures of A2 and asks again at the next
  visit.
- B6: if a certificate behind a line expires before payment, payment is refused with "<product> can
  no longer be sold in <culture>. Remove it to continue." Whether a free-shipping threshold applies
  to the whole cart or to each delivery is open until package 7.
- A seller with no approved culture is not visible anywhere (ADR-0047 decision 3). In S1 and A5 a
  request for a culture with a required certificate shows "Needs a valid <certificate> certificate"
  until the seller has one.

### Wording and trust

- B1 says: "Your choice only filters what you see. It is not a statement about you." The inline
  error "Choose at least one culture" sits under the cards and is announced with `aria-live`.
- B4 reads "Add <culture> to my view"; the count uses an ICU plural.
- B2 links the reason beside the disabled Add to cart button with `aria-describedby`.
- Culture is separate from site language; the chooser is shown in the site language.
- The culture badge on cards (B3) is text plus an icon in the existing badge component and is
  visibly distinct from the certificate seal. Only the seal means a certificate was verified
  (CERT-24); a culture badge never implies it.
- Status labels in A1 and S1 (Active, Inactive, Draft, Requested, Approved, Rejected) have a text
  label and an icon, never colour alone.

### Accessibility

- Every control has a text label; status is never shown by colour alone.
- B1 and B2 are keyboard operable. Focus returns to the header button when B1 closes. After Save or
  Add, a polite live region says "Your view now shows <cultures>".
- At 375 px: B2 is a full-width bar above the title with the button on its own row; B4 is one line
  with the button below it.
- A1 form focus order: code, names (language dropdown, then the name fields), certificate type,
  badge, status, order, Save.

### Right to left

Buyer pages mirror in Persian and Arabic. Culture names are wrapped in `<bdi>` so names in another
script keep their direction. A locale that is not published for a culture falls back to the English
name. The admin and seller panels stay English and left to right.

### SEO (B5)

`/c/<code>` has a self-referencing canonical URL, a title and description from the culture's names,
and appears in the sitemap only while the culture is Active and the switch is on.

## 5. Open before build
Wording of B1, B2 and B4 is reviewed by the UI/UX owner and, for the legal points L1 to L3 of the
plan, by the legal team before the buyer package starts.
