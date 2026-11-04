# ADR-0041: Editable service area names

**Status:** Accepted — 2026-11-04, on the project owner's decisions in the seller-city thread
(1 Nov: area names are editable in admin; 4 Nov: a table of its own, not the future settings store).
**Extends:** ADR-0005 decision 7 (ServiceArea as configuration).
**Relates to:** ADR-0018 (access rules in the application layer), the buyer multilingual rule
(English mandatory, names entered per language, never machine-translated).

## Context
A ServiceArea is one city or region, defined in `config/service-areas/<MARKET>.json` with a code,
postcodes, flags and display names per language. Renaming an area meant editing a file and
releasing. The owner wants admins to edit the names.

## Decision
1. **Only the names are data.** The code, postcodes, region and the two flags stay configuration:
   changing them moves sellers between areas and switches delivery, and needs its own design.
2. **`sellers.service_area_names`** (market_id, area_code, locale, name, updated_by, updated_at;
   primary key market, area, locale) is owned by `sellers`. A row overrides the configured name for
   that language; deleting the row restores it. English is never empty because the configured
   English name is the fallback.
3. **Reads overlay, they do not replace.** `ServiceAreaDirectory` stays synchronous and built from
   configuration. `sellers` overlays the edited names through a short in-process cache (60 seconds,
   refreshed after a local write). If the database cannot answer, the configured name is shown:
   a name is display text and never feeds a decision.
4. **Rules.** The area code must be one the Market's configuration lists; the language must be English, Persian or Arabic (the built-in list of the buyer site, plus any
   language the area configuration already uses; replaced by the Market's language registry
   later); a name is 1 to 120 characters, trimmed, with no control
   characters; nothing is machine-translated. Publishing a language needs every area's name in it
   (the buyer rule); until the certification glossary has Persian and Arabic terms, those names are
   stored but not shown to buyers.
5. **Access.** `sellers.service-area.edit` (platform scope, unprotected; the Platform Administrator
   holds every key; no default role lists it). Listing uses `sellers.seller.view`. An edit writes an
   audit row `sellers.service-area.change` (target a derived id of the area, count of names set).
6. **Migration** is reversible (`down.sql` drops the table) and backfills nothing.

## Consequences
- A rename needs no release. Two instances may show an old name for up to a minute.
- Area names appear in admin only for now. The review page and the public store keep their
  current text until their own packages.
- Later readers of edited names (the review page, the storefront) get them through a `sellers`
  contract and never query this table.
- When the platform settings store exists, the table can move into it without changing the API.
