# ADR-0046: Product Title and Description Are Entered in One Language

**Status:** Accepted — 2026-11-07, owner decisions of 25 Oct 2026 (buyer i18n plan: free text is
machine translated after a buyer language is published, admins correct it, and the buyer site
labels it "auto translation") and 31 Oct 2026 02:30Z (product title and description are entered
once, never per language; no language picker on the product forms). Recorded at build time of
the Add/Edit product pages (handoff `panels-designs-to-build.md`, page 5).
**Amends:** CAT-11 (docs/features/02-catalog-inventory.md) and INTL-10
(docs/features/09-internationalization.md) for product free text only.
**Relates to:** ADR-0002 (Market dimension, `supported_locales`), ADR-0019 (AI as a cross-cutting
capability; translation is AIS-12).

## Context
CAT-11 says names are stored per language and a language is chosen before editing. INTL-10 lists
the product name and description among the per-language business fields. The storage already
keeps texts per locale (`texts[locale]`), and the admin and seller forms of #702 and the seller
create/edit form already write only the Market's default locale. The owner decided that people
should not type every language for free text, because the list of languages will grow.

## Decision
1. On the admin and seller product forms, the title and the description are entered once, in the
   Market's default locale (English for Australia). The forms show no language picker and no
   per-language fields for them.
2. Storage stays per locale. Other locales of these two fields are filled by translation when a
   buyer language is published (AIS-12) and can be corrected by an admin. The forms send other
   locales back untouched.
3. Fixed platform lists (category names, attribute names and values, variant option names,
   certification type names) stay entered per language by people, with one language dropdown
   (owner, 31 Oct 01:40Z).
4. Label text (ingredients, allergen statement, warnings) is copied as printed: never written by
   AI and never translated.

## Consequences
- The help text under Title says it is in English and translated when a buyer language is
  published.
- No schema change. CAT-11's "choose a language before editing" no longer applies to product
  title and description.
- Translation quality and the "auto translation" label belong to the buyer i18n work, not to the
  forms.
