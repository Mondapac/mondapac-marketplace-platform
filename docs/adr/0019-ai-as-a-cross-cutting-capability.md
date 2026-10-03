# ADR-0019: AI as a Cross-Cutting Capability

**Status:** Accepted — 2026-10-03 (owner decision: the owner took the four scope decisions
on 2026-10-02, decided the customer-data and `AIG-02` / `AIG-05` questions and accepted
this ADR on 2026-10-03; drafted by the CTO, reviewed by the software-architect, the
security-tester and the product-owner, all "accept with changes", applied)
**Amends:** ADR-0008 decisions 2, 3 and 5, ADR-0013 decision 2, ADR-0015 decision 3 (two
rows added), ADR-0018 decision 7 (scope of the penetration test), `CLAUDE.md` (ADR list,
AI rules, team rules, Definition of Done), `docs/features/06-storefront-admin-platform.md`
section 5 and `docs/features/00-INDEX.md` sections 3 to 5 (codes and priority of AI;
applied by a follow-up PR)
**Relates to:** ADR-0001 decision 5, ADR-0002 decision 1, ADR-0003 decision 5, ADR-0004
decision 1, ADR-0006 decisions 1 and 4, ADR-0009 decisions 1 and 6, ADR-0010 decision 3,
ADR-0012 decision 5, ADR-0015 decisions 1, 2 and 4, ADR-0016 decision 3, ADR-0017,
ADR-0018 decision 4, ADR-0020 decision 2, `docs/design/domain/platform-foundations.md`
(sections 5.2 and 6), `docs/modules/sellers/brief.md` (SEL-25) and the Project doc
`claude/ai-plan.md` (the team's AI plan; not in the repo)

## Context
In the feature documents AI is P3: six `AIG` rows, none of them an assistant. The owner
asked for AI in the admin, seller and buyer areas from the first release; six team roles
reviewed a plan (48 use cases, proposed codes `AIP`, `AIS`, `AIA` and `AIC`) and the owner
took four scope decisions. No AI code exists. This ADR records priority, launch core,
rules and where AI code lives. It designs nothing: `platform/ai` gets a design document
(decision 6), ADR 2 comes with the G2 of `assistant`, and ADR 3 chooses the provider. The
`AIS`, `AIA` and `AIC` codes become final at the G1 of the module that hosts them, the
`AIP` codes in the `platform/ai` design. Halal is only the launch example: no rule below
names a vertical, a country or a provider.

## Decision
1. **Priority and launch core** (owner decisions 1 and 2, 2026-10-02). Only the launch
   core moves from P3 to P1. Every other use case keeps the priority the plan gives it (P2
   or P3) and stays after the MVP; nothing in AI is P0. The core is three groups.
   Certificates: filling the certificate form from the file (AIS-02) and reading the file
   for the reviewing admin, flagging inconsistencies (AIA-01), with the `AIP` platform
   items they need. Listings: the listing writer (AIS-03) and, from AIA-03, only the flag
   "certification claim in the text". Buyer: answers from the help centre (AIC-04) and,
   for signed-in customers only, "where is my order" (AIC-03). The launch date wins: a
   capability that has not passed its evaluation ships switched off, and an AI core is
   never an exit criterion of a phase.
2. **Shape** (owner decision 3). In the admin and seller panels AI is embedded in forms
   and pages; there is no chat window. Conversation exists only for the buyer, and its
   shape is decided with the storefront design. New panel UI follows ADR-0017.
3. **External AI services and data** (owner decision 4). Two conditions are the floor for
   everything sent to a model: a contract with no retention and no training, and
   processing that satisfies the data-residency requirement of the Market. The owner's
   words were "processing of documents in Australia"; in core this is the Market's
   requirement (ADR-0002 decision 1, INTL-53), never a country name. "No retention"
   includes provider-side logs and abuse-monitoring copies; the details are ADR 3. The
   owner's permission of 2026-10-02 covers certificate files and seller texts. For the
   buyer core the owner also approved, under the same two conditions, the customer's own
   message, order status and tracking, and nothing else: no address, phone or payment
   data (owner decision 2026-10-03). No other category of data goes to an external AI
   service until the owner approves it. A capability whose data cannot meet the
   conditions stays off; where a Market's residency value does not express the owner's
   condition (for example `none`), AI stays off in that Market until ADR 3 records the
   value. ADR 3 chooses the provider, with the owner's approval.
4. **Hard rules.** They go into `CLAUDE.md`. The numbers are the plan's.
   - **R1 — Model output is never a certification claim.** It is never a certification
     tag, status or badge text, nor an input to `evaluateClaim` (ADR-0012 decision 5).
     Status reaches a user only as the structured badge built from the result of
     `evaluateClaim`; a query with certification intent becomes the deterministic CERT-23
     filter. Fields that AI fills in a certificate form (AIS-02) are a draft: the seller
     submits them, and the reviewer sees per field that AI filled it. A claim guard is
     defence in depth behind the badge, not the control: deterministic, fail-closed (a
     guard error means no output), applied inside `platform/ai` through a port that
     `certification` implements, with its vocabulary from `CertificationType` data.
     Product content never asserts a certification (ADR-0010 decision 3): AIS-03 is not
     switched on until claim text is refused on the server when product content is
     submitted, for human and AI text alike (decision 12).
   - **R2 — Decisions are human; deterministic paths call no model.** No AI output
     approves, rejects, suspends, revokes, refunds or pays, ticks a manual check, counts
     as a second reviewer or recommends approval. Model output never feeds a decision use
     case, a rule-based automation, an access decision, an event or a notification; under
     the system actor it is only a labelled suggestion bound to the hash of its source
     file. `platform/ai` has one model entry point on its own path; its other exports call
     no model. `pnpm boundaries` lets only the files on one checked-in allow-list import
     it, and no file of any `domain/`, of `inventory`, `ordering`, `payments`,
     `commission-payouts` or `tax`, or on a deterministic path of decision 10, may be
     listed. A READ tool that `ordering` publishes stays legal: the model call is
     elsewhere. `identity`, `payments` and `commission-payouts` publish no AI tools;
     credentials, sessions, identity documents, payment data and payout data never reach a
     model.
   - **R3 — AI acts as the calling user.** An AI tool is not a new access path. It is a
     facade method (ADR-0008 decision 5): it carries the caller's `CallContext` (ADR-0020
     decision 2) unchanged and reaches a use case wrapped by the single authorisation
     mechanism of ADR-0018 decision 4. Seller, customer and Market come from that context,
     never from model output; an id supplied by a model is input and meets the use case's
     ownership check. There is no AI service identity and no AI component holds a
     permission: a use case that hosts a capability declares its own access rule, and this
     ADR adds no access-rule kind. Asynchronous work: the enqueuing request checks the
     switch and the acting-as state; the handler takes the Market from the event envelope
     (ADR-0006 decision 1) and the seller from the owning aggregate, re-evaluates the
     switch, and runs as the system actor without tools. No AI capability runs in an
     acting-as session ("Login as Seller", SEL-08).
   - **R4 — AI output never changes a domain record.** A capability or a DRAFT tool
     returns proposed content, or stores it as a suggestion; it takes effect only when the
     user submits it through the same use case a typed value uses (for product content, a
     Revision, VER-01..03). Tools are READ or DRAFT only, and a READ tool calls a query
     use case. A mutating tool needs a new ADR.
   - **R7 — Core names no AI provider.** A model is called only through `platform/ai`; CI
     fails an import of a provider SDK anywhere else. Provider, model and processing
     region come from the Market's configuration (ADR-0003 decision 5); there is no
     default provider, and "none" is a valid value.
   - **R8 — Every capability can be switched off, and no main flow needs AI.** With a
     capability off for the Market or the seller (decision 7), the provider failing or
     timing out, or the budget exhausted, the host flow completes on its non-AI path. An
     operator can switch a capability, or all AI, off without a release; that is tested
     before any capability is switched on for the public.
   - **R9 — Input is data; output is untrusted.** Files, user text and tool results are
     data, never instructions. Model output is validated against a schema and rendered
     inert: no HTML, no links, no images; URLs are built by code. There are no tools under
     an admin or under the system actor.
   - **R13 — No religious ruling, no health or allergy advice.** AI shows recorded data
     only and refers the user to the certificate issuer.
   - **R14 — AI does not fill a seller's commitments.** No suggestion and no DRAFT tool
     targets the Offer handling type, the per-Offer attestation (OFR-08, CERT-43) or a
     self-declaration.
   - **R15 — AI surfaces are in the mandatory security-review scope:** `platform/ai`,
     `assistant`, every AI tool declaration, and any code that sends data to a model or
     uses its output.
5. **Design rules.** R5, R6 and R10 to R12 of the plan bind the briefs and the designs;
   they are not `CLAUDE.md` lines. R5: a field allow-list per capability, SEL-15 masking
   before a model sees data, conversations under the per-subject key and in no log, event,
   audit row, cache or embedding (ADR-0009 decision 6). R6: AI content is labelled and its
   origin stored; AIA-01 shows no score and no "all clear" state. R10: legal, badge
   (CERT-24, CERT-44) and certification-type (CERT-01) texts are human-only (INTL-12).
   R11: an evaluation set per capability. R12: AI suggestion and human decision are
   recorded by the module that owns the decision, by reference and hash only.
6. **Where AI code lives (structure only).**
   - `apps/api/src/platform/ai/` is the only code that calls a model. It is platform code
     (ADR-0008 decision 2), imports no module and is not an ADR-0013 module: no brief, no
     G1. Its design is one document under `docs/design/domain/`, written in parts by the
     software-architect. The CTO approves each part, with security-tester review, before
     the first slice that consumes it (ADR-0015: designed next to its first consumer, like
     the audit-seal design). Part 1 sits beside the "AI uses" of `certification` and does
     not gate that module's own G2. One input is fixed here: no model call inside a
     UnitOfWork.
   - A new core module `assistant` (tier A, P1) hosts the buyer conversation and tool
     selection, and reads another module's data only through the tools that module
     publishes. Its gates, ADR 2 and its open owner decisions gate core 3 only. This
     amends ADR-0013 decision 2 and ADR-0008 decision 3; `docs/modules/README.md` gets its
     row when the brief is drafted.
   - An AI capability of a domain stays in that domain's module and passes its gates in an
     "AI uses" part of its brief: AIS-02 and AIA-01 in `certification`, AIS-03 and the
     AIA-03 flag in `catalog`.
   - A module publishes its AI tools in its `contracts/`, kinds READ and DRAFT only; a
     tool is a facade method (R3). This amends ADR-0008 decisions 2 and 5.
7. **Switches: who owns, who evaluates, who may change.**
   - **Evaluation** is in one place. Each capability declares itself seller-scoped or
     market-only (AIC-03 and AIC-04 are market-only). Before every model call
     `platform/ai` evaluates the capability for the Market of the call and, when it is
     seller-scoped, for the seller; a seller-scoped call without a seller id is refused.
     The id comes from the `ActorContext` for a seller actor, otherwise from the aggregate
     the host use case loaded, never from input. An acting-as session means "off" (R3). So
     does an unknown capability, a missing value or an error: a fail-safe, not the product
     default.
   - **Market level.** The switch per capability and Market is Market configuration, owned
     by the platform. Switching off without a release (R8) meets "configuration as code"
     (ADR-0003 decision 5); the mechanism is left to the pending ADR on admin-editable
     Market settings that the `sellers` brief asks for.
   - **Seller level.** `sellers` owns the per-seller setting as one of the admin-only
     settings of SEL-25, as it owns SEL-26: the value (one on/off value in the MVP), the
     use case that changes it, its permission key and its audit row. Only a platform admin
     holding that permission changes it. Off also stops the admin-side reading of that
     seller's files (AIA-01). `platform/ai` reads the value through a port that it
     declares and `sellers` implements, so `platform/` still imports no module. The port
     takes a `MarketContext` and a seller id, no actor, and is not a use case: a named
     exception recorded at the G2 of `sellers` (under the user's `CallContext` it would
     meet `sellers`' access rule and AI would be silently off). It is bound in the
     composition root; unbound, it fails boot in both `APP_ROLE`s.
   - Usage counting and limits belong to `platform/ai`; limits per principal and a
     separate buyer pool are for its design.
8. **Scheduling.** Core 1 (certificates) and core 2 (listings) run with PLAYBOOK Phase 3,
   core 3 (buyer) with Phase 6; Phase 7 adds tests only. No AI code is written in Phase 2
   and none is merged during Phase 5. No AI slice blocks a P0 slice, a launch-required P1
   slice (STO-12, STO-14, VER-12) or the launch date. An AI slice starts only after the
   facade of its host module is merged; at most one phase slice and one AI slice run at a
   time. ADR-0015 decision 3 gains two rows. `platform/ai` lands in the same change set as
   the first slice that calls a model, each further part with its first consumer; the
   per-seller switch slice of `sellers` lands before or with it. The CI rules of R2 and R7
   land in the same change as the model entry point. Core 1 triggers nothing else: the
   outbox relay and worker, the object-storage client (ADR-0016 decision 3), the audit
   writer and database roles (ADR-0015 decisions 1 and 2) and `SubjectKeyService` land
   earlier by their own triggers.
9. **Definition of Done and security review.** An AI slice is done when, besides the
   existing list: its evaluation set is versioned, synthetic and green in CI against a
   fake provider, with claim leakage at zero; the request the fake provider records
   respects the field allow-list and carries no canary data; cross-seller, cross-customer
   and cross-Market canary tests pass; injection samples pass, one of them carried by a
   file; output is rendered inert; a test walks the non-AI path to the end (capability
   off, provider timeout, budget exhausted); it runs on both Market fixtures; and
   `pnpm verify` stays offline and deterministic. No file reaches a model outside the file
   pipeline. A capability is switched on only after its evaluation with the real model is
   recorded as passed; "passed" is bound to the provider, the model and the prompt
   version, and a change of any of them re-opens it. security-tester review is mandatory
   before any AI surface is merged (R15). The launch AI surfaces join the scope of the
   independent penetration test; this amends ADR-0018 decision 7, and the quote still
   returns to the owner.
10. **What stays deterministic, and what is deferred.** No model is called on these paths:
    `evaluateClaim` and CERT-21; commission, tax, payout and refund (COM-*, PAY-*,
    RET-06); inventory reservation; the order state machine; approve and reject (SEL-03,
    CERT-11, CERT-41, CAT-32), suspend (SEL-07) and revoke (CERT-16). The rule-based
    automations (CERT-15, CERT-31, IMP-04) are not AI and stay. Semantic search and
    `pgvector` go to the search ADR that ADR-0004 decision 1 foresees. Dynamic pricing,
    demand forecasting and model-based fraud detection stay P3 and get no code.
11. **Old feature IDs.** `AIG-01` becomes AIS-03, `AIG-03` AIC-07, `AIG-04` AIC-06, and
    `AIG-06` AIP-01, AIP-02 and AIP-03; its per-seller cap maps to nothing until the
    owner's cost decision. The `AIG` rows stay, marked Deprecated, with a mapping table
    like the `HAL` table at the end of file 08 (the `HAL` rows themselves were replaced by
    a note in file 07). The new `docs/features/11-ai.md` and the edits to the two feature
    files under "Amends" are a follow-up PR of the product track. **`AIG-02` (product
    image generation) is dropped** and its row is struck through; **`AIG-05` (personalised
    checkout message) stays** after the MVP at P3, with no code, and gets a new code at
    the G1 of its host module if it is taken up (owner decision 2026-10-03; the team had
    proposed to drop both). Neither is in the launch core.
12. **Left open.**
    - The `platform/ai` design: ports, adapters and whether they are an extension point,
      usage units and limits, storage of the switches, prompt and evaluation-set versions,
      the file pipeline. ADR 2, with the G2 of `assistant`: that module, the tool contract
      and conversation data.
    - ADR 3, before the first model call: provider, model, processing region and the
      Market's residency value, allowed data categories, contract, dependencies, cost cap.
    - Module briefs: the guard's vocabulary needs a field on CERT-01 (`certification`).
      The feature documents state the refusal of claim text only for PLATFORM content
      (CAT-41); its form for SELLER content is a `catalog` rule, confirmed at that
      module's G1.
    - The owner: the default of the per-seller switch for a new seller, which has a cost
      side and a consent side (off until the seller agrees that their files go to an
      external AI service?), asked with the `certification` brief and with legal input; AI
      cost and the free cap per seller; conversation retention; the shopping assistant for
      signed-in customers only; input languages; the assistant's name; the provider and
      its monthly cap; legal counsel.

## Consequences
- The Brisbane scope grows by a P1 area that nobody has estimated; no module has passed G2
  and this ADR gives no estimate. Until the follow-up PR the feature documents still say
  P3; this ADR prevails.
- Cores 1 and 2 wait for part 1 of the `platform/ai` design and the G2 of their host
  modules, not for `assistant`.
- `sellers` owns one more setting and implements one port; its switch slice is unblocked.
- R2 and R9 forbid some later items of the plan as written (for example the payout
  explanation AIS-14, and AIA-02 with identity documents); each needs a new ADR.
- R3 relies on the mechanism of platform-foundations section 6, which binds only once
  identity's G2 approves it; no AI tool is built before that.
- Every AI slice needs a security review, with the limits ADR-0018 records for it; the
  penetration test grows before its price is known.
- Legal points are risks and questions for counsel, not conclusions; the plan's sources
  were not checked again. They say that from 10 December 2026 a privacy policy must name
  the decisions with a significant effect on individuals in which a computer program
  decides or plays a substantial and direct part (AIA-01 may be one). Misleading AI output
  and silence about AI use are consumer-law risks.

## Alternatives considered
- Keep AI at P3, or make all 48 use cases P0: the owner chose a P1 core.
- One central `ai` module that owns every AI capability, or an AI service identity with
  its own permissions: the first reads every module's data and carries every domain's
  rules (ADR-0009 decision 1); the second is a second access path (ADR-0018 decision 4).
- Design `platform/ai` inside the G2 of `assistant` (the plan): it puts the open
  conversation decisions on the path of the Phase 3 cores, which use no tools.
- `platform/ai` owns and stores the per-seller switch (the plan's AIP-02 as written): an
  admin-changed setting needs a use case, a permission key and an audit row; permission
  keys are declared by modules (ADR-0018 decision 4) and platform code passes no gate.
- Each host module asks `sellers` and passes the answer to `platform/ai`: as many
  evaluation points as callers, and one forgotten check is a silent bypass.
- A word filter as the control for claims: the security-tester found it insufficient.
  Mutating tools behind a confirmation: R9 assumes an injection succeeds.
