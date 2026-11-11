# ADR-0047: Multi-culture as an Optional, Admin-defined Catalog Dimension

**Status:** Accepted — 2026-11-02, on the project owner's decisions in the multi-culture design
thread (21:26Z to 22:04Z: model B, guests choose too, brand statement, switch default off, all
sellers join the first culture, category default "certification required", separate delivery per
culture, build after categories, attributes and variants with only this package earlier). Sources in
the Project folder: `design/culture-sections/culture-model-b-plan-fa.html` (the plan this ADR
fixes) and `design/culture-sections/culture-models-plan-fa.html` (the comparison with a separate
Market per culture, which was not chosen).
**Builds on:** ADR-0001 decision 5 (no vertical or group name in core code), ADR-0040 (admin-defined
data with names per locale, a seller link that is reviewed, server-side enforcement, fail closed).
**Relates to:** ADR-0002 and ADR-0003 (Market stays a country-level dimension; a culture lives
inside a Market), ADR-0012 and `evaluateClaim` (certification is unchanged and only read),
ADR-0026 (the switch is an admin-editable Market setting), ADR-0043 (the `Eat` section follows the
buyer's cultures), ADR-0044 decision 7 (a restaurant joins a culture like any seller; this ADR
satisfies that dependency).
**Screens:** `docs/design/cultures/screens.md`.

## Context
MondaPac started as a halal marketplace. The owner's statement (2026-11-02, 21:29Z) is that MondaPac
has not promised halal to customers: the halal market is the starting point of the business and the
slogan is "a market for all cultures". The owner wants buyers to
choose which cultures they see and buy from (an Iranian buyer may buy Chinese food; an Arab buyer
may want halal only), and sellers of another culture to be shown separately from halal sellers.
"Culture" means a community and the product standard that goes with it. It is not a language
label and not an ethnicity label of a buyer or seller. The first culture is "Muslim community and
halal products". The platform is not launched and its data is test data.

The alternative, a second Market per culture, was compared and rejected: it would split accounts,
carts and admins (ADR-0003 decision 4, ADR-0018) and needs a country-level change to ADR-0002.

## Decision
1. **A culture is data owned by `catalog`.** An admin defines it per Market at Catalog › Cultures:
   `catalog.cultures` (fixed English code, status Draft/Active/Inactive, order, optional
   `required_certification_type`, colour or badge) and `catalog.culture_names` (name and short
   description per locale; English required; a locale is published only when all its names exist;
   never machine-translated). All three tables carry `market_id` and `tenant_id`. Exactly one Active culture is marked
   the default of the Market. Core code never names a culture (ADR-0001 decision 5). The plan asked
   this ADR to fix the table names; they are only proposed here and become final in package 1,
   which records them in the catalog data design.
2. **One optional switch, in the settings store.** `multi-culture` is a platform-level Market
   setting kept in the `settings` module (ADR-0042 decision 4) with `enabled`, `defaultCultures` and
   `showChooserOnFirstVisit`, and its own keys `settings.multi-culture.view` and
   `settings.multi-culture.manage` (ADR-0042 decision 2). Its safe value, returned on a missing row
   or a read failure, is the restrictive one: switch off and the default culture (ADR-0026 decision
   5). The setting is reviewed by security-tester because it decides what buyers see (ADR-0026
   decision 9). While the switch is off the culture filter is not applied at all, so what buyers see
   is exactly what they see today: no chooser, no culture badge, and stored buyer choices are
   ignored. It can be turned on only when at least two cultures are Active and each has an approved
   seller. The confirmation shows how many Offers and sellers each culture would show or hide.
   Turning it off deletes nothing. Changes are audited.
3. **A seller joins cultures by request and review.** `sellers.seller_cultures` holds seller,
   culture, status (requested, approved, rejected), reviewer, date and reason; a later change is a
   change request, as for business activities (ADR-0040 decision 4). A seller with no approved
   culture is not shown anywhere (fail closed). While the switch is off a new seller is attached to
   the default culture automatically, without a certificate check, because no filter applies yet.
   When the switch is turned on, every membership in a culture with a required certification type is
   checked once; a seller without a valid certificate of that type goes back to "requested" and is
   hidden there until approved, and the confirmation of decision 2 shows how many. A seller who sells a product outside the standard of a
   certified culture does not join it. For a culture with a required certification type, approval
   needs the seller's valid certificate of that type, read through the existing certification
   contract. Membership is decided by products and standard, never by ethnicity.
4. **One shared category tree.** Categories are not duplicated per culture. A culture sees a branch
   unless an admin hides it (`catalog.culture_categories`). A branch can be created for one
   culture's own product and made visible only there. Category names never assert a certification.
5. **Visibility rule.** An Offer is visible in a culture when its seller is approved for that
   culture and its category is visible there. For a culture with a required certification type
   there is a second condition: if the category is marked "certification required" (the default,
   inherited from the parent branch unless an admin overrides it), the Offer must carry a tag of the culture's required
   certification type and `evaluateClaim` must allow that tag for this Offer (an Offer without the tag
   is not visible there, and no claim is inferred); a category marked "neutral" (rice, fresh vegetables) needs membership only. An
   expired, suspended, incomplete or failed certificate means the Offer is not visible. A seller of
   several cultures is evaluated per Offer. A buyer sees an Offer when at least one chosen culture
   makes it visible.
6. **Enforced on the server, by one function.** The BFF forwards the buyer's cultures; the API
   filters every buyer read through one shared function owned by `catalog` (a facade). Lists and
   search apply it on the search read model (`culture_codes`); single-Offer reads, the cart and
   checkout call the facade. It reads other modules only through their facades and never joins across
   schemas. A missing or invalid list means the
   Market's default cultures, never "all". A contract test covers every buyer read path (lists,
   search, recommendations, shelves, slides, "others also bought", email, assistant).
7. **Buyer choice.** Stored in the customer profile as `culture_preferences` and, for a guest, in a
   cookie that moves to the profile on sign-in or sign-up. At least one culture is always chosen. If a chosen culture becomes
   Inactive it is dropped from the stored choice, and if none remains the default cultures apply.
   Only the culture codes are stored, nothing else about the buyer.
   Language and culture are separate choices. A direct link to a product outside the choice opens
   the page with a warning bar and a button to add that culture; Add to cart stays closed until it
   is added. Search that finds nothing in the chosen cultures but something in another shows one
   line with the count and an add button, never the products.
8. **Search index and events.** The index gets `culture_codes`; every change of membership,
   certificate, category or "neutral" mark emits an event and re-indexes the Offer. The producers are `sellers` (membership), certification (certificates),
   and `catalog` (category visibility, the "neutral" mark, and a culture's status change); `search`
   consumes them. Until the new
   index arrives, a certified culture's shelf re-checks the certificate at read time, as the halal
   shelf does today.
9. **Cart and delivery.** One cart, one account and one payment across cultures. Each cart and
   order line carries `culture_code` (when an Offer is visible in two of the buyer's cultures, the
   one with a required certification wins, and between two certified cultures the lower display
   order wins). The `culture_code` of a line never changes after purchase. At checkout the order is
   split into one delivery shipment per seller and culture (an existing per-seller split stays), each with its own courier, time and shipping fee, shown before the buyer
   confirms ("This order arrives in 2 separate deliveries"). Whether a free-shipping threshold
   applies to the whole cart or to each shipment is decided in package 7. A line whose culture the
   buyer removed stays in the cart with a bar and needs confirmation before payment. If a
   certificate behind a certified line expires between add and pay, payment is refused with a clear
   message; the pay-time check runs `evaluateClaim` again in the checkout saga through the
   certification facade, and that step is security-reviewed.
10. **Certification and claims.** The claim guard stays on for all cultures: a seller without a
    certificate cannot write "halal" in a store name or product text. Before names are published in
    a new language, the claim terms of that language must be added by a person who knows it (for
    example the Chinese word for halal); the same gate applies to every language a culture brings.
11. **Hard-coded halal text goes.** The halal seal in the footer, the "Become a seller" page and
    the assistant quick buttons are built from culture data and no longer fixed in code.
12. **Permissions.** `catalog.culture.read` is a platform key, unprotected. `catalog.culture.edit`
    is a protected key: it edits the required certification type and the "certification required" or
    "neutral" marks, which decide whether uncertified Offers are shown in a certified culture. The
    Platform Administrator holds both. The switch uses the `settings.multi-culture.*` keys of
    decision 2. Approving a seller's membership needs the seller-review permission. The visibility
    rule and the shared filter are security-reviewed when built.
13. **Regulated categories wait.** Alcohol, imported meat and similar categories are not enabled for
    any later culture before the legal questions on them are answered. Legal and tax questions L1
    to L7 of the plan (anti-discrimination, sensitive-data status of a buyer's choice, consumer-law
    promise of the halal view, regulated goods, labels, GST) are open and are not decided here.
    Until L2 is answered, a buyer's culture choice is not used for marketing, and only the minimum
    data (the culture codes) is stored.

## Consequences
- This package (0) adds this ADR and the screen document only. No code, schema or config changes,
  and nothing reads it yet.
- Packages follow after the categories, attributes and variants programme, backend first:
  1 `catalog` tables and admin API, 2 `sellers` membership and the test seed that attaches every
  seller to the first culture, 3 visibility rule, switch, index field and shared filter with its
  contract test, 4 buyer preference and BFF, 5 admin frontend, 6 buyer frontend, 7 cart, order,
  delivery split, assistant, recommendations and promotions. Everything merges behind the switch,
  so today's behaviour does not change until it is turned on.
- ADR-0044 decision 7 no longer waits on an unaccepted plan.
- Risks and their mitigation (one filter plus a contract test; double condition for certified
  categories; hiding rather than showing wrongly when an admin forgets a "neutral" mark; the
  hidden-in-view label in the seller panel, built from the culture's name, and an admin report) are recorded in the
  plan and carried into the package briefs.
