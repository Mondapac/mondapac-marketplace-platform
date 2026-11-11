# ADR-0048: The Buyer Site's Map Is Mapbox GL JS, Loaded on Demand

**Status:** Accepted — 2026-11-11, cto decision for the "Deliver to" location tool (owner request
of 11 Nov 2026: finish the tool). Recorded at build time.
**Relates to:** ADR-0002 (Market dimension), ADR-0005 (ServiceArea rollout), ADR-0033 (Next.js
base), the storefront CSP (`apps/web/src/security/storefront-csp.ts`).

## Context
The Deliver to modal had a drawn stub map behind one seam (`DeliveryMapProps`). The address search
already uses Mapbox Geocoding on the server, so a Mapbox map adds no new vendor. The buyer site
has a strict CSP (`worker-src 'self'`, no `blob:`), and the map library is large.

## Decision
1. The real map is `mapbox-gl` v3 (pinned version), behind the same `DeliveryMapProps` as the stub.
2. It is loaded only when the modal opens (`next/dynamic`, `ssr: false`), as one separate chunk.
3. We use the library's CSP build. Its worker is copied from the package to `public/vendor/` when
   `server.mjs` starts and served from our own origin, so `worker-src 'self'` stays and no `blob:`
   is added. `connect-src` gains `https://api.mapbox.com https://events.mapbox.com` only when a
   map token is set (also while the live search is off and the stub map shows; these are two fixed
   Mapbox origins, accepted to keep the policy independent of the search settings).
4. The map uses its own public token (`MAPBOX_MAP_TOKEN`, a `pk.` token with only the styles and
   tiles scopes, URL-restricted to the site's hosts). It is never the server search token, never
   in code, and never a `NEXT_PUBLIC_` variable; the server hands it to the modal. A secret
   `sk.` token, or the search token's value, is refused at start-up. The style (`MAPBOX_MAP_STYLE`) is configuration.
5. The centre, the delivery area and the bounds come from the Market's data, not from code.
6. The pin is our own button inside the map's marker, so it keeps its accessible name and moves
   with the arrow keys. Rotation and pitch are off.
7. Without a token, or if the map cannot start (no WebGL, chunk failure), the stub map is shown.
   Mapbox's attribution stays visible as its terms require.

## Consequences
- Mapbox GL JS v2+ is under a proprietary licence and every map load counts toward Mapbox usage;
  an operator sets a usage alert in the Mapbox account.
- `events.mapbox.com` receives the buyer's IP address and map-load events, so the privacy page
  lists Mapbox as the map's processor.
- Each Region Stack's deploy checklist checks the token's URL restriction and scopes in the
  Mapbox account; the code cannot check them.
- Today there is one map token per deployment (one Region Stack). When one deployment hosts
  several Markets with different Mapbox accounts or styles, the token and style move to Market
  configuration.
- A change of map provider replaces one component behind `DeliveryMapProps`.
