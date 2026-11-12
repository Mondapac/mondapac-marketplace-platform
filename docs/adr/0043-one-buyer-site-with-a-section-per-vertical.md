# ADR-0043: One Buyer Site with a Section per Vertical

**Status:** Accepted — 2026-11-04, owner decision (restaurants plan, Q1 at 10:05Z: "one site, two
sections"; Q4 at 10:14Z: the ecosystem is one country for now; Q5 at 10:15Z: buyer and seller
logins stay separate). The plan and the owner's answers are in the Project folder at
`design/restaurants/restaurants-one-account-plan-fa.html`.
**Amends:** ADR-0001 decision 4 (a separate storefront per vertical); ADR-0008 decision 1
(`apps/web` as the first vertical storefront) and decision 6 (the literal check).
**Relates to:** ADR-0003 decision 4 and ADR-0018 decision 3 (accounts belong to one Market and one
population), ADR-0034 (panel apps), ADR-0044 (restaurant vertical).

## Context
ADR-0001 decision 4 planned one headless storefront (Next.js app) per vertical. The owner wants
one buyer account across the whole Mondapac ecosystem, and the second vertical is hot food from
restaurants. Accounts already belong to a Market, not to a vertical (ADR-0018 decision 3), so a
restaurant vertical inside the AU Market gets the same buyer account for free. A second site
would still split the session across two hosts and repeat the header, account, wallet, address
book and culture choice.

## Decision
1. **One buyer site per Market.** `apps/web` hosts every vertical of the Market. Each vertical is
   a named section of that site: today `Shop` (retail, the current site) and `Eat` (restaurants,
   ADR-0044). A section is switched on per Market by a platform setting; while it is off its
   routes return not found and its navigation is hidden.
2. **Shared across sections:** the account, sign-in session, profile, site language, culture
   choice (multi-culture plan), address book, saved payment methods, wallet and gift credit,
   notifications and marketing consent, order history (filtered by section), reviews and the
   shopping assistant.
3. **Per section:** the cart (a section never mixes its lines with another's), the home and
   listing pages, and the section's own order tracking. A discount code may be limited to one
   section.
4. **Isolation inside the site.** Each section lives under its own URL segment and route folder
   (`/eat`, `apps/web/app/eat/...`), its own feature folder and its own BFF module. `Shop` keeps
   today's URLs. Shared shell code (header, account pages, design system use) never branches
   on a section name; a section adds itself through a section registry (name, routes,
   navigation entry, setting key). The literal check of ADR-0008 decision 6 is extended to
   flag a section name in the shared shell folders of `apps/web` (the shell, account and
   shared component folders; the exact globs are listed with the check). The first PR of
   package R7 delivers this check before any `Eat` page.
5. **How core knows a section.** Core modules never name a section. A section is an opaque
   key from Market configuration (`config/markets/`), like a ServiceArea id.
   - An offer belongs to a section through its product type: a product type registration
     declares its section key (`menu_item` declares the restaurant section's key); a product
     type that declares none belongs to the Market's default section.
   - The `Cart` aggregate is per customer, Market and section key. Each section has a cart
     policy value in configuration, for example "at most one seller per cart". The `Cart`
     aggregate enforces that policy when a line is added; the UI only explains it.
   - An order records the section key of its cart. Order history filters on it, and a
     discount code may list the section keys it applies to.
6. **The Core API stays vertical-agnostic** (ADR-0001 decision 4, second half, unchanged): the
   site's BFF modules call the same Core API.
7. **Out of scope:** one account across Markets (countries), and one sign-in for buying and
   selling. Buyer and seller accounts stay separate populations (ADR-0018 decision 3); the same
   email may be used in both.

## Consequences
- A buyer moves between groceries and restaurants without a second sign-in.
- ADR-0001 chose separate sites because the user experience of each vertical differs (fast
  ordering for food, quotes and bulk buying for trade; horizontal-extensibility architecture,
  section 3 and pitfall 4), not to share code. One site keeps that: each section has its own
  pages, layouts and flows (home, listing, item, cart and tracking), and only the shell,
  account and design system are shared. There is no generic page configured per vertical.
- The route segment, BFF module and shell check keep a section's conditions out of shared code.
- Core gains one opaque key (section) on carts and orders and a cart policy value; neither
  names a vertical.
- No identity or session change is needed. The panels (ADR-0034) are not affected: one seller
  panel and one admin panel serve every vertical.
- A later vertical (for example Trade) is a new section, not a new site, unless a new ADR
  decides otherwise for that vertical.
- The horizontal-extensibility architecture document gets an "Amended by ADR-0043" note in a
  small PR of its own (it is a shared file).

## Alternatives considered
- A separate restaurant site with a shared sign-in (parent-domain cookie or single sign-on):
  rejected by the owner (Q1); it adds cross-domain session security work and repeats the
  account pages.
- One account across Markets: deferred (Q4); it would amend ADR-0003 decision 4.
- Section rules only in the BFF: rejected; a rule such as one restaurant per cart must hold for
  every client, so the `Cart` aggregate enforces it.
