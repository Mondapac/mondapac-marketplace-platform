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
structure). Phase 1 added ADR-0014 (runtime and toolchain baseline), ADR-0016 (local object storage,
Proposed) and ADR-0015 (Phase 1
scope; deferred platform foundations and the trigger that forces each one - check it
before starting a slice). Follow them; change one only through a new superseding ADR.
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

## Commands
- Requires Node.js 24.9+ and pnpm 10 (ADR-0014).
- `docker compose up -d` starts Postgres, Redis, mail catcher (no object storage yet, ADR-0016). Copy `.env.example`
  to `.env` first.
- `pnpm install` / `pnpm dev` / `pnpm build` / `pnpm lint` / `pnpm typecheck` / `pnpm format`
- `pnpm test` (unit + HTTP tests, no database) / `pnpm test:db` (needs Postgres; creates
  and drops its own throwaway database)
- `pnpm boundaries` checks module and persistence boundaries (ADR-0008 decision 6).
- `pnpm db:migrate` applies migrations; `pnpm db:migrate:dev` creates one and regenerates
  the Prisma client (then add its `down.sql`); `pnpm db:generate` regenerates the client; `pnpm db:check-reversible` runs up -> down -> up on a throwaway database.
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
    mondapac-module-gate (ADR-0013 gates), mondapac-role-review (team review of a proposal).
    Account skill mondapac-design-system-update: any new or changed UI (ADR-0017).
12. Design system first (ADR-0017, owner decision 2026-10-02): the Figma file "MondaPac
    Design System" is the source of truth for panel UI. Whenever a module, page, feature or
    slice adds or changes UI, extend the design system in Figma first (components, variants,
    states, tokens, icons, templates), export the tokens to docs/design/tokens/ and update
    docs/design/figma/README.md, following docs/design/figma/update-procedure.md (account
    skill mondapac-design-system-update). Frontend code uses
    only exported tokens and library components; record the impact in brief section 12.

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
  anything in auth, payments, or the certification (CERT-*) enforcement path.
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
