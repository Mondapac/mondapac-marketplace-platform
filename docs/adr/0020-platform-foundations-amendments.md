# ADR-0020: Platform Foundations — Amendments to Earlier ADRs

**Status:** Accepted — 2026-10-03 (CTO, with the approval of the platform-foundations
design, after review by the security-tester, the database-designer and the
backend-developer). The owner is informed in the Phase 2 status summary; no item changes a
decision the owner made, so no owner decision was asked.
**Amends:** ADR-0003 decision 2, ADR-0008 decision 1, ADR-0009 decision 4, ADR-0015
decision 3 (row 1; one row added)
**Relates to:** ADR-0001 decision 2, ADR-0004 decisions 4 and 7, ADR-0005 decision 5,
ADR-0006 decision 1, ADR-0008 decision 4, ADR-0009 decisions 2 and 6, ADR-0013, ADR-0014
decision 8, ADR-0015 decisions 1 and 4, ADR-0018 decisions 4 and 6,
`docs/design/domain/platform-foundations.md` (options, evidence and trade-offs),
`docs/design/data/platform.md`, `docs/modules/identity/brief.md` (R7)

## Context
ADR-0015 decision 3 requires a "platform foundations" design before the first identity
domain code. Writing and reviewing it showed several places where an Accepted ADR is
silent, can be read two ways, or is at odds with another one. A design document cannot
settle those: an Accepted ADR changes only through an ADR. This ADR records the decisions
and nothing else; the reasoning is in the design document.

## Decision
1. **ADR-0009 value types are designed with their first consumer.** `Revision<T>`,
   `ContentHash` and `EffectivePeriod` are not designed in the platform-foundations
   design. Each is designed in the approved design of its first consumer: that module's
   G2, or the audit-seal design (ADR-0015 decision 1) if that is the first to need
   `ContentHash`. What ADR-0009 decisions 2 and 6 fix about them stays binding.
   `ActorContext` stays in the platform-foundations design (ADR-0018 decision 6); its
   fields are completed in identity's G2 design and written back there. This amends
   ADR-0015 decision 3, row 1.
2. **Shared-kernel list.** `packages/shared-kernel/` also holds `ActorContext` (ADR-0018
   decision 6), `CorrelationId` (the type of the envelope's `correlation_id`, ADR-0006
   decision 1) and `CallContext` (the `MarketContext`, the `ActorContext` and the
   correlation id of one piece of work, passed explicitly). Helper types and functions
   that belong to a listed type (`MarketId`, `TenantId`, `IdGenerator`, the Temporal
   re-export) need no entry. This amends ADR-0008 decision 1 and the type list of ADR-0015
   decision 3, row 1.
3. **Market of an HTTP request.** The API takes the Market from one explicit request
   header, `x-market-id`, and from nothing else. A missing, repeated or malformed header,
   or a Market outside `HOSTED_MARKETS`, is refused; there is still no default. The
   "host/domain mapping" of ADR-0003 decision 2 is the job of the tier in front of the API
   (a BFF, a panel server or the edge): it maps the host to a Market and overwrites any
   header the client sent. Mapping hosts inside the API may be added later by a
   CTO-approved design with security-tester review; a host and a header that disagree are
   then refused. This amends ADR-0003 decision 2.
4. **Market `status` has no runtime meaning yet.** In Phase 2 "hosted" is the only gate:
   `status` (`planned`, `soft_launch`, `active`, `suspended`) is validated and otherwise
   ignored. ADR-0015 decision 3 gains a row: the meaning of each status is decided, and
   enforced where the `MarketContext` is built, before the first deployed environment the
   public can reach. What a customer or a seller sees in each status is a business
   question for the owner at that point.
5. **`identity` and `legal`.** R7 of the identity brief, which ADR-0018 decision 4 makes
   binding, says `identity` imports no business module; ADR-0009 decision 4 says
   `identity` records acceptance through the `legal` facade. Until the `legal` gate R7
   holds without exception: the CI rule that enforces it has an empty allow-list. The
   `legal` gate decides, as a named CTO decision, either to add `legal` to that list or to
   record acceptance without `identity` importing `legal`. That `legal` owns the consent
   record does not change. This amends ADR-0009 decision 4.
6. **Tenant value.** "Defaulting" in ADR-0001 decision 2 and "seeded `'mondapac'`" in
   ADR-0004 decision 4 mean supplied by the application: one named constant in
   `platform/`, carried in `MarketContext`. `tenant_id` has no database default, no Prisma
   default and no environment variable. This records the reading already approved in
   `docs/design/data/platform.md`; the text of neither ADR changes.
7. **Temporal polyfill package.** The polyfill approved by ADR-0008 decision 4 is
   `temporal-polyfill`, pinned to an exact version and imported by the shared kernel only.
   If the dependency PR cannot show the kernel tests, the api tests, the build and an
   unflagged start passing on the ADR-0014 minimum Node version, `@js-temporal/polyfill`
   is used instead without a new decision; the PR records which package landed.
8. **Correlation ids are generated, never accepted.** The API generates the correlation
   id of every request. A caller's `x-correlation-id` is logged once as `clientRequestId`
   and reaches no audit row, outbox row or event: a caller-chosen string in an immutable
   row could never be erased (ADR-0009 decision 6). This changes the Phase 1 behaviour of
   `platform/logging/`; no ADR text changes.

## Consequences
- QC reads ADR-0015 decision 3 with these notes: identity code does not wait for the three
  value types, and no environment the public can reach is deployed before Market status
  has a meaning.
- The frontend topology ADR (D2) must say which tier sends `x-market-id`. A browser that
  calls the API directly would have to send it itself, which needs a CORS decision.
- The `legal` module inherits an open decision. It is recorded here so that it is not
  first met as a failing CI rule.
- If `temporal-polyfill` lands, the kernel's test script gains the test-only
  `--experimental-vm-modules` flag (ADR-0014 decision 8). Changing the package, or moving
  to native Temporal, changes one kernel file.
- A caller can no longer choose an end-to-end correlation id; it correlates through the
  response header or `clientRequestId`.
- No configuration error can write a second tenant value. Real multi-tenancy would replace
  the constant at the one place a `MarketContext` is built.

## Alternatives considered
- Inline notes without an ADR: every existing note cites an ADR, and a note with no
  decision behind it is a silent change.
- Design the three value types now: nothing in Phase 2 names their shape (ADR-0015: each
  foundation is designed next to its first consumer).
- Host mapping inside the API now: needs a host field in Market configuration, a
  trust-proxy decision and the domain strategy; none of them exists yet.
- Give Market `status` a meaning now: no deployment exists, and part of the meaning is a
  business decision.
- Allow `identity` to import `legal` now: there is no `legal` brief or gate to decide it
  against.
- Tenant value from an environment variable: it fails closed only when missing; a typo
  would silently write a second tenant into every row.
- `@js-temporal/polyfill` as the first choice: no test-script change, but it is a 0.x
  release last published in March 2025 whose README does not yet call it production-ready.
