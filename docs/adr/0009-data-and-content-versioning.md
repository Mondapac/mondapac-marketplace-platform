# ADR-0009: Data and Content Versioning

**Status:** Accepted — 2026-09-30 (owner). Editorial content, including the blog, is
required for the Brisbane launch.
**Full analysis:** `docs/architecture/data-and-content-versioning.md`
**Relates to:** ADR-0004 (persistence, audit log), ADR-0007 (order snapshots),
ADR-0008 (module boundaries), CAT-30..37, IMP-03, IMP-06, IMP-10, CERT-17, CERT-21,
STO-11/12, INTL-12, CUS-03, INTL-52, VER-* (`docs/features/10-versioning.md`)

## Context
Several parts of the platform need to keep, compare and restore earlier versions of data:
product content under approval (today a seller can change an approved product with no
review — CAT-34, IMP-03), proof of what a customer saw and agreed to at purchase,
editorial content (blog, CMS pages, page sections, legal documents in several languages),
configuration that changes over time (commission, tax, service areas), and sensitive data
(payout accounts, certification documents, personal data) where history must be
tamper-evident yet compatible with privacy obligations. One central "versioning service"
was considered.

## Decision
1. **No central versioning service.** Versioning is a platform capability — shared value
   types plus conventions — applied inside each owning module. A central service would
   have to read every module's data (breaking ADR-0008) and would concentrate personal data
   from every module in one place.
2. **Four patterns.** Every entity's design names the pattern it uses:
   - **V1 Revisioned content.** `<entity>` + `<entity>_revision` whose content is immutable
     (`revision_no`, content, `content_hash`, author, `created_at`, `change_note`; status
     moves Pending → Approved / Rejected / Superseded) and a `published_revision_id`
     pointer. Publishing or rolling back moves the pointer or copies an old revision into a
     new one. Used for: Product content, seller public profile and policies (SEL-24),
     SellerCertification submissions, CertificationType and AttributeSchema definitions,
     legal documents.
   - **V2 Effective-dated records.** `valid_from` / `valid_to timestamptz` plus an
     `EXCLUDE USING gist` no-overlap constraint (btree_gist) added in raw SQL, with
     future-dated changes and "as of instant" queries. Used for: commission rates
     (COM-01/02), offer prices, tax configuration, ServiceArea activation, payout account
     links.
   - **V3 Snapshot at reference.** Transactional records store the referenced revision id,
     its `content_hash` and a minimal copy of what was agreed: order lines (product
     revision, offer id and price, tax, certification tags shown), invoices, and consent
     records (legal document revision). Extends ADR-0007 decision 8.
   - **V4 Append-only history.** Status histories (CERT-17, order status) and the platform
     audit log (ADR-0004 decision 7). The audit write stays in the caller's transaction; a
     worker then seals rows, in order, into a per-market hash chain so tampering is
     detectable (IMP-06) without serialising every audited write.
3. **Product approval uses revisions (implements IMP-03; CAT-34 superseded by VER-03).**
   The approved revision stays live while an edit creates a pending revision. The
   `catalog` module's `ProductRevisionPolicy` (driven by Market/Vertical config) sends
   sensitive changes — category, tax category, name, main images — to
   review while the live revision keeps selling; minor changes publish immediately. Offer
   price jumps above a per-market threshold are held for review by the offer's owning
   module (a pending V2 record), and certification tags live on Offers (ADR-0010); IMP-03
   applies to those at Offer level. Sellers never revise PLATFORM product content. When
   `Approval Required` (CAT-36) is off, every revision publishes immediately; CERT-21 is
   still enforced at submit and continuously. A rejected revision stays rejected; the next
   edit creates a new pending revision (CAT-32).
4. **Editorial and legal content.**
   - Blog, CMS pages (STO-12), page sections (STO-11) and banners live in a self-hosted
     headless CMS as `apps/cms`, with its own `cms` schema in each Region Stack (not
     Prisma; its migrations must support down). The product is chosen in ADR-0011 after a
     short proof of concept (candidate: Payload 3). The storefront reads only published
     content through the CMS API.
   - A new core module `legal` (P1) owns `legal_document_revision` and `consent_record`.
     On a CMS publish webhook it pulls the rendered document through the CMS read API (an
     adapter in `legal/infrastructure`), hashes it and stores it. The CMS never writes to
     api schemas and never depends on api modules. `identity` records acceptance through
     the `legal` facade. *(Amended by ADR-0020: how `identity` reaches `legal` is decided
     at the `legal` gate; until then `identity` imports no business module, R7 of the
     identity brief.)*
5. **Files.** Object storage uses bucket versioning and content-addressed keys (sha256).
   Evidence under legal retention (certification documents, legal-document renders) goes
   to a bucket with Object Lock (retention mode).
6. **Sensitive data and privacy.**
   - Personal fields kept in revisions or history are encrypted with per-subject data keys,
     stored wrapped under a regional KMS key (not one KMS key per subject).
   - `content_hash` and audit hashes over personal fields are HMACs with the subject's key,
     or are computed over ciphertext, so a destroyed key cannot be bypassed by guessing
     against a plaintext hash.
   - An erasure or de-identification request (CUS-03, INTL-52) destroys the subject's key;
     the data counts as erased only once backup retention has passed. Records under legal
     retention follow the Market's retention config first.
   - Personal data never goes into event payloads, outbox, caches, logs, search indexes or
     audit before/after values (from Phase 2).
   - Reading the history of sensitive entities needs its own permission and is itself
     audited.
   - The platform stores only the payment provider's connected-account id, never bank
     details. Changing the payout account link is V2 plus step-up verification, a
     notification to the seller and a hold period before the next payout; security-tester
     review is mandatory.
7. **Retention.** Published revisions are kept; unpublished drafts are pruned after a
   configurable period; large history tables are partitioned by time.
8. **Building blocks.** `Revision<T>`, `ContentHash` and `EffectivePeriod` are value
   types in the shared kernel; the platform provides the hash-chained `AuditLog` and a
   `SubjectKeyService` port. Each module owns its own revision policy. Phase 1 ships the
   value types and the audit hash chain; the rest arrives in the first slice that needs it.
   *(Amended by ADR-0015: the value types and the hash chain also arrive with the first
   slice that needs them, before any audit row is written.)*
9. **Out of scope:** dataset versioning for analytics/ML (decided with the P3 analytics
   ADR), full bitemporal modelling, Event Sourcing (ADR-0004).

## Consequences
- Sellers can improve listings without taking them off sale, and risky edits cannot bypass
  review.
- Every order and consent can prove exactly what was shown and agreed.
- More storage and slightly more complex queries (`as of`, pointer joins inside a module).
- One more app to run and upgrade per Region Stack (the CMS) from P1.
- Key management is needed from the first personal-data table (Phase 2).

## Alternatives considered
- **Central versioning service:** rejected — breaks module boundaries and concentrates
  personal data (decision 1).
- **Generic JSON-diff audit only:** rejected — cannot drive publish, review or rollback.
- **Event Sourcing:** rejected for the MVP in ADR-0004.
- **PostgreSQL 18 temporal keys (`WITHOUT OVERLAPS`):** rejected for now — Prisma cannot
  map them; the `EXCLUDE` constraint gives the same guarantee on any supported version.
- **Building the CMS in-house:** several extra weeks for the editor, preview, localisation
  and scheduling.
- **SaaS CMS:** data-residency questions per region and per-seat cost.
- **Git-based content:** not usable by non-technical editors.
