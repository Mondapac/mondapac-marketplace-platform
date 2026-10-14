# Project status

Last updated: 2026-10-14. Short summary for anyone joining the project. Detailed rules live in
`CLAUDE.md`; design records live in `docs/`.

## Architecture

- Multi-vendor marketplace, first Market Australia (halal-certified launch). Built multi-market
  from day one: every market-scoped record carries `market_id`, money is integer minor units
  plus ISO 4217 currency, and tests run against AU plus a synthetic second market (ZZ).
- Modular monolith in `apps/api` (NestJS, TypeScript, Prisma v7, PostgreSQL, Redis). Each
  module in `apps/api/src/modules` owns its own database schema and talks to other modules only
  through public contracts or domain events (outbox). Layers: presentation, application,
  domain, infrastructure.
- Shared runtime in `apps/api/src/platform`: authorization, audit log, clock, events and
  outbox, Market config, rate limits, scheduler, worker, mail, logging, unit of work.
- Authorization is decided in the application layer: every use case takes an actor and a
  Market context and declares its access rule (ADR-0018).
- Panels: `apps/admin` (platform admin) and `apps/seller` (seller panel), Next.js 16 and
  React 19, sharing `packages/ui` and `packages/panel-server`. `packages/shared-kernel` holds
  framework-free types.
- Database: one Prisma schema file per module, timestamped migrations with `down.sql`. The
  API runs as a least-privilege role (`mondapac_api`); migrations run as `mondapac_migrator`.
- Payments use hosted Stripe services (Stripe Checkout now, Stripe Connect for seller
  payouts later). Phase 5 follows the hybrid plan: keep built modules, build the rest with
  minimal layers and hosted services.
- CI: GitHub Actions runs `pnpm verify` (typecheck, lint, boundaries, unit and database tests,
  migration reversibility) on the Node minimum and the `.nvmrc` version.

## Done

Backend modules (working code with tests):

- identity: admin and seller accounts, sign-in with two-step for admins, invitations, password
  reset, platform and seller roles with a custom role editor, permission catalogue.
- sellers: seller application (business file, register lookup, tax identifiers, store
  profile, time zone), submit and withdraw, admin list, review read, approve and reject,
  may-sell contract (slice 9).
- catalog: platform and seller products (drafts, categories, tax class, attributes, variants),
  offers (create, edit, submit, delete, handling), admin offer review queue.
- certification: certification facade and claim-term matching.
- pricing: regular prices, scheduled special prices, held prices with admin approve and
  reject, effective-price read.
- inventory: stock locations, stock per variant and location, 15-minute checkout
  reservations, commit, cancel and ship of reservation lines, reserve rate limit.
- cart: guest and customer carts with stock-checked add, update, remove and merge.
- ordering: checkout from the cart through Stripe Checkout in test mode (manual capture),
  order reads, internal confirm and cancel that commit or release inventory.

Panels:

- Admin: team, roles and role editor, invitations with authenticator setup, seller list and
  application review with decisions, held price queue, offer review queue.
- Seller: sign-up and sign-in, application submit and status, products and draft editor,
  offers, stock locations and stock levels, regular and special prices.
- Both panels are responsive (phone drawer, seller bottom bar, touch-size controls) and checked
  at 375, 768 and 1280 px in light and dark themes; table headers align with their cells.

Local demo:

- `scripts\demo-local.bat` starts a local demo with a sample Brisbane marketplace seed
  (`scripts/demo-seed`). Nothing is deployed online yet.

## Current issues

- Real money is blocked until a registered Australian tax agent is engaged; Stripe runs in
  test mode only.
- CI flakes: "Initialize containers", the Node minimum job and an occasional unreadable Verify
  job. A flaky run is re-run once; workflows are not edited to hide it.
- Pull request events sometimes do not reach the session watching a PR, so a silent PR is
  checked by hand.
- Checkout leftovers (phase 5 package 1): order and payment emails, order page in the UI,
  scheduled job for unpaid orders, cancel and refund, admin order index, default grants for
  the support and finance roles.
- There is no buyer storefront app yet; a design prototype is waiting for reference samples.
- Before first sale: catalog media upload (slice 13), certification slices 1 to 10, catalog
  tags, the ADR-0031 registry, issue #133, guest cart rate limit and purge job, minimum order.
- Pricing leftovers: boundary jobs for special prices, per-account write cap, special price
  windows in the seller's time zone (the UI shows UTC only).

## Next steps

In progress:

- PR #278: optional two-step sign-in for sellers.
- PR #277: store the recorded offer handling; the demo seed uses the handling endpoint.
- Phase 5 package 2: Stripe webhook receiver.
- Buyer storefront prototype (design only).

Queue, in order:

1. Buyer storefront build, mobile first, after the prototype is approved.
2. Sellers follow-ups: identity tabs in the seller list (6b), submit again and re-apply (7b),
   Phase 5 seller items S-a to S-d.
3. Certification raw-read port fix (R-1) with a security review.
4. Catalog media upload (slice 13).
5. Admin Customers page, after identity slice 8d.
6. Phase 5 packages 3 to 9: seller connected accounts, delivery with flat shipping,
   commission and seller ledger, payouts, refunds, disputes, GST and invoices.

Modules that are still empty shells: payments, shipping, tax, commission-payouts, returns,
search, notifications.
