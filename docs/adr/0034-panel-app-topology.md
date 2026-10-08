# ADR-0034: Panel App Topology (D2); amends ADR-0008

**Status:** Proposed — 2026-10-08. For Ali (cto) and Mohammad (software-architect); Hassan
(security-tester) must confirm decisions 2 to 4 (hosts, cookies, CSRF, session) before the first
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
   `seller.<domain>`, `admin.<domain>`). Cookies ignore ports, so locally the panels run on
   `seller.localhost` and `admin.localhost` (never two ports of one host); an XSS in one panel
   can then neither read the other's CSRF token nor use its cookie (HF7). Hosts multiply by
   Market; the naming scheme and certificate (wildcard per Market) belong to the DevOps slice.
   Identity spike 5 (`__Host-` on plain http, Safari) is a prerequisite of the sign-in slice.
3. **The panel server is the BFF.** The browser talks only to its own host. A Next.js route
   handler relays an **allowlist** of API paths (only the panel's own population routes under
   `identity/<population>` and later the routes its screens use; never swagger or health;
   `..` and encoded dots rejected). Rules:
   - **Market:** it **sets** `x-market-id` from the normalised request host (lower case, no
     port, no trailing dot; `X-Forwarded-Host` is read only when the edge is a configured
     trusted hop) through a map that is **derived from Market configuration** (`HOSTED_MARKETS`
     and `allowedOrigins`) and checked against them at start-up, not a second hand-kept list.
     It drops any `x-market-id` from the browser. An unknown host answers 404. No default Market.
   - **Cookies:** it relays every `Set-Cookie` unchanged, using `headers.getSetCookie()` (a
     merged header breaks the `__Host-` attributes), with no `Domain` rewrite and no cookie of its own.
   - **CSRF and origin:** the API's origin check is fail-open when `Origin` or `Sec-Fetch-Site`
     is absent, and a server-side `fetch` sends neither. So the BFF itself **rejects** every
     unsafe-method request whose `Origin` or `Sec-Fetch-Site` does not satisfy both `Sec-Fetch-Site: same-origin` and an `Origin` exactly equal to the
     panel's own origin (scheme, host and port), then forwards the browser's values and
     `x-csrf-token` verbatim. `allowedOrigins` is kept **per population**: admin routes accept only
     the admin origin, seller routes only the seller origin, so the API's own check still holds behind the BFF.
     It refuses any request carrying `Authorization` (HF14).
   - **Client address:** the API throttles per origin (identity.md 6.8). The BFF forwards the
     client address in one header it sets itself (it drops `x-forwarded-*` and `forwarded` from the
     incoming request unless they come from a configured trusted hop, the same rule as `X-Forwarded-Host`), the API trusts that header only from the panel hosts' network (the trust-proxy
     hop count, identity.md I4, is settled in the deployment slice), and the API is not
     reachable from outside that network. This is a **gate for the sign-in slice**: the slice does
     not merge until Hassan confirms it, or per-origin throttles would treat every user as one.
   - **Correlation:** the API issues the correlation id (ADR-0020); the BFF logs the response
     header and the client request id and never sends its own.
   - **Hygiene:** request headers are an allowlist (`Cookie`, `Content-Type`, `Accept`, `Origin`,
     `Sec-Fetch-Site`, `x-csrf-token`, plus the headers set above); credentialed answers that set no
     `Cache-Control` get `private, no-store`, and session answers always carry `no-store`. It adds no business logic and never logs a
     session token or password.
4. **Session in the app.** A server component may *read* the actor summary
   (`GET identity/<population>/session`) with `cache: 'no-store'` to choose the page, using the same mapping and header code as the relay (Market from host,
   client address, no `Authorization`), but it cannot set cookies. Anything that may clear or rotate the cookie (a `session.invalid`
   answer, sign-in, change-password) goes through the relay route handler, which redirects.
   The CSRF token from the summary is held in memory by the page and carried through client
   navigations in the RSC payload; pages that render it are `private, no-store`. A hard reload
   fetches it again. No client-side role logic is trusted: the API decides; the UI hides what the
   summary says is not allowed.
5. **No cross-origin API calls from the browser.** No CORS with credentials is introduced.
6. **Security headers.** Each app sends a nonce-based Content-Security-Policy,
   `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, a strict referrer policy,
   HSTS, `Cross-Origin-Opener-Policy: same-origin` and a restrictive `Permissions-Policy`;
   `dangerouslySetInnerHTML` is banned by lint. Access control is checked in the relay and the
   page, not by Next middleware alone. Next.js and React advisories are patched within the
   cadence Kazem sets (DevOps slice).
7. **Contract types.** The apps do not import API code. Types and Zod schemas are generated
   from the OpenAPI document into `packages/api-client` (a later slice); until then each slice
   hand-writes a small typed client plus a contract test against the API's DTO examples, and
   those schemas are advisory (the server answer is the authority).
8. **Shared kernel.** The apps may import only value types from `packages/shared-kernel`
   (`Money`, ids, formatting), never `ActorContext` or `CallContext` (server-side types). The
   package is consumed through its built ESM output; `scripts/check-built-kernel.mjs` is extended
   to the new consumers.
9. **Boundaries.** `pnpm boundaries` gains rules (in the shell PR): apps import neither
   `apps/api` nor each other; `packages/ui` imports no app; lint/review bans `if (panel)` branching.
10. **Uploads.** Large files (certificates, images) do not stream through the BFF. They use the
    API's upload route per ADR-0029 directly through the relay with a size limit set there, or
    presigned URLs if ADR-0029 provides them; decided in the first slice that needs a file.
11. **Local run.** `pnpm dev` stays the API. `pnpm dev:seller` and `pnpm dev:admin` run each
    panel against it; the mail catcher shows the verification mail (Compose).
12. **Out of scope.** Deployment details (Kazem) and Login-as-Seller (SEL-08), which needs its own host decision.

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
