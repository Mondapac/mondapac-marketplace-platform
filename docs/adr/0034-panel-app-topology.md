# ADR-0034: Panel App Topology (D2); amends ADR-0008

**Status:** Proposed — 2026-10-08. For Ali (cto) and Mohammad (software-architect); Hassan
(security-tester) must confirm decisions 3 to 5 (cookies, CSRF, hosts) before the first
sign-in slice merges.
**Relates to:** ADR-0008 (repository structure; `apps/web`), ADR-0018 and
`docs/design/domain/identity.md` 6.4 (cookie, CSRF, HF7), ADR-0020 decision 3
(`x-market-id`), ADR-0033 (UI base), board request 6.

## Context
ADR-0008 reserved `apps/web` for the first vertical storefront and its BFF. The admin and
seller panels are built first and are a different product with different risk: an admin
session must never share a browser origin with a seller page. Identity (6.4) already issues
`__Host-` cookies with no `Domain`, so each cookie works only on the host that set it, and asks
this ADR for separate hosts per panel and for the tier that sends `x-market-id`.

## Decision
1. **Layout.** Two thin Next.js apps and one shared package:
   ```
   apps/seller/    seller panel (Next.js)
   apps/admin/     admin panel (Next.js)
   packages/ui/    components, shell (AppShell, Sidebar, Topbar, NavDrawer, BottomTabBar),
                   token mapping, icons (ADR-0033)
   ```
   `apps/web` stays reserved for the storefront (ADR-0008 is amended only to add the two
   panel apps and `packages/ui` to its layout). The menu is configuration: each app passes its
   nav config and permission keys to the shared shell; there is no `if (panel === ...)` in `packages/ui`.
2. **Separate hosts.** Each panel and the storefront have their own host (for example
   `seller.<domain>`, `admin.<domain>`; locally `localhost:3001` and `localhost:3002`).
   An XSS in one cannot read the other's CSRF token or use its cookie (HF7).
3. **The panel server is the BFF.** The browser talks only to its own host. A Next.js route
   handler relays `/api/*` to the API unchanged, except for these rules:
   - it **sets** `x-market-id` from the request host through a server-side map
     (`PANEL_MARKET_BY_HOST`, validated at start-up); it drops any `x-market-id` sent by the
     browser; an unknown host answers 404; there is no default Market (ADR-0020 decision 3);
   - it relays `Set-Cookie` unchanged and keeps the `__Host-` rules; it adds no cookie of its own;
   - it forwards `x-csrf-token`, `Origin`/`Sec-Fetch-Site`, `x-correlation-id`, and refuses a request
     with an `Authorization` header (HF14);
   - it adds no business logic and never reads or logs a session token or password.
4. **Session in the app.** Server components read the actor summary
   (`GET identity/<population>/session`) with the browser's cookie to decide the page, and the
   CSRF token from that answer is held in memory by the page, never in storage. A 401
   (`session.invalid`) sends the user to sign-in. No client-side role logic is trusted: the API
   decides; the UI only hides what the actor summary says it cannot do.
5. **No cross-origin API calls from the browser.** No CORS with credentials is introduced.
6. **Contract types.** The apps do not import API code. Request and response types come from
   the OpenAPI document of `apps/api`, generated into a `packages/api-client` package in a later
   slice; until then each slice writes its own small typed client in the app and a contract test
   that checks it against the API's DTO examples.
7. **Local run.** `pnpm dev` stays the API. `pnpm dev:seller` and `pnpm dev:admin` run each
   panel against `localhost:3000`; the mail catcher shows the verification mail (Compose).
8. **Deployment** (Kazem): one container image per app, host-based routing at the edge. The
   details belong to the DevOps slice; nothing here depends on a provider.

## Consequences
- The API stays free of host or CORS logic, as ADR-0020 intends.
- Each panel can be released and rolled back alone; `packages/ui` is the only coupling.
- Three hosts (including the storefront) need three certificates and a local hosts-file or port convention.
- Two Next.js servers cost more to run than one; accepted for the isolation Hassan asked for.

## Alternatives rejected
- **One app with route groups:** one origin for both panels breaks HF7.
- **Browser calls the API directly with CORS:** needs credentialed CORS and exposes the
  Market header to the browser; ADR-0020 asked for the opposite.
- **A single shared Next.js app with middleware by host:** one deploy unit and one bundle for both
  panels; an admin-only dependency would ship to sellers.
