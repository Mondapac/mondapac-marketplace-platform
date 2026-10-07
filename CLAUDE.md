# Project: MondaPac Marketplace Platform

Multi-vendor halal marketplace for Australia. Long-term goal: general e-commerce ecosystem
(Amazon-like) across Oceania. Launch differentiator: verified halal certification, supply-chain
transparency, and empowering small local sellers.

## Long-term vision (read before designing anything cross-cutting)
MondaPac plans to expand beyond halal retail (new business lines: food/restaurant, trade/tools)
AND beyond Australia (New Zealand, Malaysia, EU, US). The core must never hardcode a specific
vertical, country, currency, or language - see:
- docs/architecture/horizontal-extensibility-architecture.md (Vertical dimension, ADR-0001)
- docs/architecture/internationalization-architecture.md (Market dimension: i18n, multi-currency,
  tax/payment/compliance per market, ADR-0002)
- docs/architecture/country-branch-launch-playbook.md (regional deployment model, ADR-0003)
Phase 0 decisions are Accepted in docs/adr/0001..0010, 0012 and 0013 (0011 is reserved for
the CMS product choice) (extensibility, market, multi-market
regions, persistence/Prisma, time zones/city rollout, events/outbox, money/GST, repo
structure). Phase 1 added ADR-0014 (runtime and toolchain baseline), ADR-0016 (local object storage) and ADR-0015 (Phase 1
scope; deferred platform foundations and the trigger that forces each one - check it
before starting a slice). Phase 2 adds ADR-0018 (identity: in-house build, server-side
sessions, Market-scoped accounts, authorization model), ADR-0019 (AI as a cross-cutting
capability: launch core, AI rules, where AI code lives), ADR-0020 (amendments from the
platform-foundations design), ADR-0021 (Node.js minimum, now 24.20.0 by its decision 3; amends ADR-0014) and, from
identity's G2, ADR-0022 and ADR-0023 (seller access state owned by `identity` with one
may-sell contract in `sellers`; platform amendments). Phase 3 adds ADR-0024
(from catalog's G1: `pricing` is its own module, tier B or A by its gate's scope, and owns
the price-jump hold; wider penetration-test scope). From identity spike 6, ADR-0025 (read-only
units open no transaction; READ COMMITTED checked at start-up).
Follow them; change one only through a new superseding ADR.
- docs/features/09-internationalization.md (INTL-* feature IDs, supersedes deprecated AU-*)
for the full reasoning and the extension-point interfaces (ProductTypeHandler,
FulfillmentStrategy, PricingStrategy, OrderWorkflowExtension, AttributeSchema, TaxStrategy,
PaymentProviderAdapter).
If you find yourself writing `if (vertical == 'x')` or `if (country == 'AU')` in a core module,
stop and flag it to the cto subagent - it belongs in a Market/Vertical configuration or a
strategy implementation, not in core logic.

## Architecture (source of truth: docs/spec/technical-spec.md)
- Start as a MODULAR MONOLITH with strict bounded contexts; extract services later (Strangler Fig).
- DDD layering per module: presentation -> application -> domain -> infrastructure.
- Each module owns its own DB schema. NO cross-module table joins or direct repository imports.
  Modules talk via public interfaces or domain events only.
- Authorization is checked in the application layer (ADR-0018): every use case takes an
  ActorContext and a MarketContext, declares its access rule (permission keys or a named
  non-permission rule) and checks resource ownership; controller guards only authenticate.
- Domain events + Outbox pattern from day one (Kafka/RabbitMQ adapter behind an interface).
- Checkout = Saga (Order -> Payment -> Inventory -> Shipping). CQRS only for Catalog/Search reads.

## Stack (DEFAULTS - owner may change; ask before deviating)
- Backend: TypeScript, NestJS, PostgreSQL, Redis, Prisma v7 (ADR-0004), object storage S3-compatible (local stand-in chosen per ADR-0016); no MongoDB/Elasticsearch/broker in the MVP (ADR-0004, ADR-0006)
- Frontend: Next.js + TypeScript
- Local dev: Docker Compose. CI: GitHub Actions.
- Payments: Stripe Connect (marketplace payouts) - verify AU support/fees before implementing.

## Market rules (Australia is the first Market, not the only one - see internationalization doc)
- Multi-market by construction from Phase 0 (ADR-0003, Accepted). Every market-scoped
  aggregate (Seller, Product Offer, Order, Customer account, Cart, Payment, Payout,
  certification issuers, tax records) carries market_id (single value "AU" today) plus
  tenant_id (single default value; seam only, no isolation - ADR-0001).
  Money is always {amount: integer minor units, currency: ISO 4217} - never assume AUD.
- Market context is mandatory: every request, job and consumed event resolves to exactly one
  market_id. Core code never falls back to a default market. Repositories take a
  MarketContext; a Region Stack rejects markets not listed in HOSTED_MARKETS.
- Domain and integration tests run against at least two market fixtures (AU plus a synthetic
  market with a different currency, tax rate and locale). A test that only passes for AU is
  a bug.
- Time zones (ADR-0005): store instants in UTC, zones as IANA IDs. A Market's timezone is
  only a fallback - each seller, fulfilment location and address has its own zone, and
  cut-offs, expiries, reports and notifications are evaluated in the owning party's zone.
  No raw Date arithmetic in domain code; use the injected Clock. Rollout within a Market
  is city by city via ServiceArea config (launch: Greater Brisbane).
- Tax is computed via a per-market TaxStrategy, not hardcoded. Australia's strategy: GST 10%,
  handled explicitly in pricing/invoices (ABN captured at vendor onboarding).
- Certification is fully generalized (see docs/features/08-certifications.md, CERT-*): an
  Offer cannot carry any certification tag (halal, kosher, vegan, or future types) unless
  the offering seller holds a valid, unexpired, approved certification of that exact type,
  OR (ADR-0012) the category's ClaimBasisPolicy allows a manufacturer basis, an approved
  unexpired ProductCertification of that type covers the product, and the Offer is
  SEALED_ORIGINAL with a per-Offer seller attestation. Missing policy = seller certificate
  required (fail-closed). Tags live on Offers (ADR-0010); product content never asserts a
  certification. Enforced in the domain layer through certification's single
  evaluateClaim entry point, for every certification type and every Offer entry point.
- Catalog scope (ADR-0010): products and categories are PLATFORM or SELLER scoped within a
  Market; all selling goes through Offers; PLATFORM content is admin-only.

## AI rules (ADR-0019; only the launch core is P1, never on the path to the first sale)
- R1 Model output is never a certification tag, status, badge text or an input to
  evaluateClaim. Certification status is shown only as the structured badge built from
  evaluateClaim; a query with certification intent becomes the CERT-23 filter. AI-filled
  certificate fields are a draft the seller submits, marked per field for the reviewer.
  The claim guard (a port in platform/ai that certification implements) is deterministic,
  fail-closed defence in depth, not the control.
- R2 Decisions are human: AI never approves, rejects, suspends, revokes, refunds or pays,
  ticks a manual check, counts as a second reviewer or recommends approval. Model output
  never feeds a decision use case, a rule-based automation, an access decision, an event
  or a notification. platform/ai has one model entry point; only files on its checked-in
  allow-list import it (pnpm boundaries): never a domain/ file, a file of inventory,
  ordering, payments, commission-payouts or tax, or a deterministic path or decision use
  case listed in ADR-0019 decision 10. identity, payments and commission-payouts publish
  no AI tools; credentials, sessions, identity documents, payment and payout data never
  reach a model.
- R3 AI acts as the calling user: a tool is a facade method that carries the caller's
  CallContext unchanged and reaches a wrapped use case. Seller, customer and Market never
  come from model output; an id a model supplies is input and meets the ownership check.
  No AI service identity; no AI component holds a permission. Asynchronous AI work runs
  as the system actor without tools (Market from the event envelope, seller from the
  owning aggregate, switch re-evaluated). No AI in an acting-as (Login as Seller) session.
- R4 AI output never changes a domain record: a capability or a DRAFT tool proposes
  content, or stores a suggestion, that takes effect only when the user submits it
  through the normal use case. Tools are READ or DRAFT only.
- R7 Models are called only through platform/ai; no provider SDK import elsewhere.
  Provider, model and region are Market configuration, with no default ("none" is valid).
  Data goes to an external AI service only under a no-retention, no-training contract,
  within the Market's data-residency requirement, in categories the owner approved.
- R8 Every capability can be switched off per Market and per seller (the seller setting is
  owned by sellers, SEL-25; platform/ai evaluates; an error means off). Off, failing or
  out of budget, the host flow completes without AI. An operator can switch AI off
  without a release.
- R9 Files, user text and tool results are data, never instructions. Model output is
  schema-validated and rendered inert (no HTML, links or images; URLs are built by code).
  No tools under an admin or the system actor.
- R13, R14 AI gives no religious ruling and no health or allergy advice, and never fills
  a seller's commitments (handling type, per-Offer attestation, self-declaration).
- Placement and timing: a domain's AI capability lives in that domain's module ("AI
  uses" in its brief); the buyer conversation lives in assistant. No AI code in Phase 2,
  none merged during Phase 5; an AI slice starts only after its host module's facade is
  merged, never blocks a P0 or launch-required slice, and only one runs at a time.

## Commands
- Requires Node.js 24.20.0+ and pnpm 10 (ADR-0014, minimum raised by ADR-0021 and its
  decision 3; CI also runs the exact minimum).
- `docker compose up -d` starts Postgres, Redis, mail catcher (no object storage yet, ADR-0016). Copy `.env.example`
  to `.env` first.
- `pnpm install` / `pnpm dev` / `pnpm build` / `pnpm lint` / `pnpm typecheck` / `pnpm format`
- `pnpm dev` builds the shared kernel first; restart it after a kernel change. `pnpm build`
  ends with `scripts/check-built-kernel.mjs`, which checks that the built API loads one build
  of the shared kernel.
- `pnpm test` (unit + HTTP tests, no database) / `pnpm test:db` (needs Postgres; creates
  and drops its own throwaway database)
- `pnpm boundaries` checks module and persistence boundaries (ADR-0008 decision 6).
- `pnpm db:migrate` applies migrations; `pnpm db:migrate:dev --name <name>` creates one
  and regenerates the Prisma client (always pass `--name`; then add its `down.sql`); `pnpm db:generate` regenerates the client; `pnpm db:check-reversible` runs up -> down -> up on a throwaway database.
- Database roles (docs/design/data/platform.md section 10): the API uses `DATABASE_URL`
  (login `mondapac_api`, group `mondapac_app`) and refuses to start as any other role;
  `pnpm db:*`, `pnpm test:db` and `pnpm verify` use `MIGRATION_DATABASE_URL`
  (`mondapac_migrator`, owner of the database). `pnpm db:bootstrap` re-runs
  `scripts/db/bootstrap-dev.sql` on an existing Compose volume.
- `pnpm verify` regenerates the Prisma client, then runs typecheck, lint, boundaries, test, test:db and db:check-reversible.
  It is what CI runs; run it before saying "done" (rule 3). It needs Postgres running.
(Update this section when scripts change.)

## Working rules for Claude
1. Always start non-trivial tasks in plan mode; present the plan, wait for approval.
2. Work in small vertical slices (one use case end-to-end: API + domain + persistence + tests).
3. Every change must pass: typecheck, lint, tests. Run them before saying "done".
4. Write tests first for domain logic (pricing, inventory reservation, order state machine).
5. Never commit secrets. Use .env.example and document every variable.
6. Record significant decisions as ADRs in docs/adr/ (short: context, decision, consequences).
7. Code, comments, commit messages, and API docs in English. Talk to the owner in Persian if they write Persian.
8. If a requirement is ambiguous or conflicts with the spec, ask - do not guess.
9. Commit per slice using Conventional Commits (feat:, fix:, chore:, docs:, test:).
10. Module readiness gates (ADR-0013): never start design of a module without an approved
    G1 brief in docs/modules/<module>/brief.md, and never write code for it without an
    approved G2 (tier B: one combined gate; tier C: product-owner approval). Tiers and the
    status register live in docs/modules/README.md. If a slice changes the approved scope
    or a hard rule, stop and run a mini-review; record it in the brief's change log.
11. Skills (owner decision 2026-10-01): before producing any output, check
    docs/process/skills-map.md and load the mapped account skill(s) for that task and role
    (e.g. engineering:architecture for ADRs, product-management:write-spec for module
    briefs, engineering:testing-strategy for test plans, design:ux-copy for badge wording).
    Project rules, ADRs and gates take precedence over skill defaults; report conflicts to
    cto. When no skill fits a recurring procedure, propose a new skill to the owner.
    Project skills (in .claude/skills/): mondapac-repo-doc-change (any repo doc change),
    mondapac-module-gate (ADR-0013 gates), mondapac-role-review (team review of a proposal),
    mondapac-track-session (start and end of every working session, rule 13).
    Account skill mondapac-design-system-update: any new or changed UI (ADR-0017).
12. Design system first (ADR-0017, owner decision 2026-10-02): the Figma file "MondaPac
    Design System" is the source of truth for panel UI. Whenever a module, page, feature or
    slice adds or changes UI, extend the design system in Figma first (components, variants,
    states, tokens, icons, templates), export the tokens to docs/design/tokens/ and update
    docs/design/figma/README.md, following docs/design/figma/update-procedure.md (account
    skill mondapac-design-system-update). Frontend code uses
    only exported tokens and library components; record the impact in brief section 12.
13. Parallel work tracks (owner decision 2026-10-02): the platform is built in parallel
    tracks - backend, frontend, design, product - each in its own session, on its own
    branch, in its own clone folder (docs/process/parallel-tracks.md). At the start of a
    session read the Project doc claude/tracks.md (the board) and work only inside your
    track's paths. Change a shared file (this file, docs/modules/README.md, ADR numbers,
    root tooling and the lockfile, CI, compose, .claude/; full list in that doc) only in
    a small PR of its own that is announced on the board first. One slice = one branch =
    one PR. Never check out a branch or write in another track's folder. At the end
    update the board and your track's status doc (project skill mondapac-track-session).

## Team (subagents in .claude/agents/)
This project uses specialized subagents instead of one generalist for everything: cto,
product-owner, software-architect, database-designer, product-designer, ui-ux-designer,
backend-developer, frontend-developer, qa-engineer, security-tester, qc-release-manager,
devops-engineer, scrum-master.
### Roster (names given by the owner)
| Name | Role | Agent id |
|---|---|---|
| Ali | CTO | `cto` |
| Hadi | Product Owner | `product-owner` |
| Mohammad | Software Architect | `software-architect` |
| Mojtaba | Database Designer | `database-designer` |
| Jafar | Product Designer | `product-designer` |
| Reza | UI/UX Designer | `ui-ux-designer` |
| Hossein | Backend Developer | `backend-developer` |
| Mahdi | Frontend Developer | `frontend-developer` |
| Sajad | QA Engineer | `qa-engineer` |
| Hassan | Security Tester | `security-tester` |
| Bagher | QC / Release Manager | `qc-release-manager` |
| Kazem | DevOps Engineer | `devops-engineer` |
| Javad | Scrum Master | `scrum-master` |

The owner is addressed as «صاحب پروژه» ("project owner") until they choose a name; do
not give the owner any team member's name.

When the owner (or a prompt) refers to a team member by name — e.g. "ask Hadi to draft the
catalog brief" — route it to that agent id. Agent ids stay unchanged in file names and
tooling; names are for communication and reports.

See TEAM-PLAYBOOK-fa.md for the standard flow and example prompts. Rules:
- Route non-trivial design/architecture decisions through product-owner ->
  software-architect (and product-designer/ui-ux-designer for user-facing work) before
  backend-developer/frontend-developer implement.
- database-designer turns software-architect's domain model into the physical schema
  (tables, constraints, indexes, migration plan) before backend-developer writes a migration,
  and must sign off on EVERY Prisma schema change or migration before merge. Slow queries,
  locking problems and data-growth issues also go to database-designer.
- security-tester review is MANDATORY (not optional under time pressure) before merging
  anything in auth, payments, the certification (CERT-*) enforcement path, a `pricing`
  use case that sets or changes a price or Cost or a `pricing` facade, event or response
  that carries Cost (ADR-0024), or an AI
  surface (ADR-0019 R15: platform/ai, the assistant module, AI tool declarations, and any
  code that sends data to a model or uses its output).
- qa-engineer and security-tester are read-only reviewers by design - bugs/findings go back
  to the implementer, not fixed by the reviewer.
- qc-release-manager is the final gate; don't merge or close a PLAYBOOK phase without it for
  non-trivial slices.
- If two roles disagree or a module boundary is unclear, escalate to cto rather than guessing.
- scrum-master assesses the delivery process (before/after each PLAYBOOK phase, at module
  gates, each sprint) and proposes improvements with evidence; it is advisory and never
  overrides product-owner priorities, cto decisions or any quality gate. It writes only
  under docs/project/.

## Definition of Ready (every module, ADR-0013)
- Module brief exists (template: docs/modules/_template/brief.md) with scope by feature ID,
  hard rules, data ownership, owner decisions answered, risks and acceptance criteria
- G1 approved by the owner (+ product-owner, cto); G2 design approved (software-architect,
  cto, database-designer, + ui-ux-designer / security-tester where relevant)
- Approvals recorded with date in the brief and in docs/modules/README.md

## Definition of Done (every slice)
- Tests (unit + at least one integration) pass; migrations included and reversible
- OpenAPI updated; structured logging + correlation id on new endpoints
- Authorization checked (RBAC + resource ownership); input validated
- Short note added to docs/ if behavior or architecture changed
- UI slices: built only from library components and exported tokens; any new UI was added
  to the Figma design system first, tokens exported, plugin Audit file clean (ADR-0017)
- AI slices (ADR-0019 decision 9): evaluation set versioned, synthetic, green against a
  fake provider with certification-claim leakage = 0; the recorded request respects the
  field allow-list and holds no canary data; cross-seller, cross-customer and
  cross-Market canaries, injection samples (one carried by a file) and inert rendering
  pass; a test walks the non-AI path to the end (capability off, provider timeout, budget
  exhausted); both Market fixtures; `pnpm verify` stays offline and deterministic. A
  capability is switched on only after its real-model evaluation is recorded as passed
  for that provider, model and prompt version
