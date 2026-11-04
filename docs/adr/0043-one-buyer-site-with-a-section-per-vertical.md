# ADR-0043: One Buyer Site with a Section per Vertical

**Status:** Accepted — 2026-11-04, owner decision (restaurants plan, Q1 at 10:05Z: "one site, two
sections"; Q4 at 10:14Z: the ecosystem is one country for now; Q5 at 10:15Z: buyer and seller
logins stay separate).
**Amends:** ADR-0001 decision 4 (a separate storefront per vertical).
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
   today's URLs. Shared shell code
   (header, account, design system) never branches on a section name; a section adds itself
   through a section registry (name, routes, navigation entry, setting key). The vertical
   check of ADR-0001 decision 5 is extended to flag a section name inside shared shell code.
5. **The Core API stays vertical-agnostic** (ADR-0001 decision 4, second half, unchanged): the
   site's BFF modules call the same Core API.
6. **Out of scope:** one account across Markets (countries), and one sign-in for buying and
   selling. Buyer and seller accounts stay separate populations (ADR-0018 decision 3); the same
   email may be used in both.

## Consequences
- A buyer moves between groceries and restaurants without a second sign-in.
- The site carries more than one vertical; the route group, BFF module and shell check keep a
  section's conditions out of shared code, which was ADR-0001's reason for separate sites.
- No identity or session change is needed. The panels (ADR-0034) are not affected: one seller
  panel and one admin panel serve every vertical.
- A later vertical (for example Trade) is a new section, not a new site, unless a new ADR
  decides otherwise for that vertical.

## Alternatives considered
- A separate restaurant site with a shared sign-in (parent-domain cookie or single sign-on):
  rejected by the owner (Q1); it adds cross-domain session security work and repeats the
  account pages.
- One account across Markets: deferred (Q4); it would amend ADR-0003 decision 4.
