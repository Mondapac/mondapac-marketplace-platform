# ADR-0023: Platform Amendments from Identity G2

**Status:** Proposed — accepted with the identity G2 approval (CTO, 2026-10-03), after review
by Mohammad (software-architect) and Hassan (security-tester). No owner decision is changed,
so none is asked; the owner is informed in the G2 summary.
**Amends:** ADR-0004 decision 5, ADR-0006 decisions 4 and 7, ADR-0008 decision 2, ADR-0015
decision 3 (its reading, and the row "UnitOfWork, outbox relay, event bus, scheduler,
`APP_ROLE`")
**Relates to:** ADR-0006 decision 5, ADR-0008 decision 5, ADR-0013, ADR-0018 decisions 2
and 3, ADR-0020, `CLAUDE.md` rule 13, `docs/design/domain/platform-persistence-and-events.md`
(PA1 to PA8; sections 3.1, 6.4, 6.5, 7 and 12.1), `docs/design/domain/identity.md`
(sections 6.3, 6.8, 9, 12.1 and 14.1 items 5 to 7)

## Context
Identity's G2 design and the platform design for the UnitOfWork, outbox, relay, scheduler
and `APP_ROLE` found places where an Accepted ADR is stricter than the design can be, is
silent, or names a mechanism that does not work as written with Prisma. A design document
cannot change an Accepted ADR, so this ADR records the decisions; the reasons and the
evidence are in the two design documents. The Node minimum (ADR-0014) is ADR-0021's.

## Decision
1. **Units of work in a use case (ADR-0004 decision 5).** The use-case body opens its units
   itself (PA2). A use case opens at most one read-write unit. Read-only units may come
   before it when slow work (password hashing, sending mail, a facade read) needs stored
   data; the write unit then re-checks what was read, through the aggregate version. No
   hashing, mail, HTTP, facade or model call runs inside a unit. The access gate
   (`Authenticator`, `AuthorisationCheck`) reads committed state in a unit of its own,
   before the body runs. One further write unit is allowed: a short reservation unit before
   a credential is verified. It counts the attempt (`attempts + 1 … RETURNING`) and refuses
   at the threshold without verifying, so parallel requests get no more guesses than the
   threshold; the write unit after the check releases the reservation (Hassan's finding 1).
   Read-only work still runs in a transaction, as decision 5 says; that is revisited with
   the measurements of identity spike 6 (PA5).
2. **Event delivery lands with the first subscription (ADR-0006 decision 4).** The publish
   path (outbox writer, relay, `EventBus` port, in-process adapter) lands in identity slice
   1b. The consume side (`platform.event_delivery`, fan-out, dispatcher, back-off, dead
   letter, `<module>.inbox`, `runOnce`) lands in the same change as the first subscription.
   That subscription is `identity`'s mail handlers on its own events, in slice 3; "consumes
   none" in the identity brief (section 6) means other modules' events (PA1, 14.1 item 6).
   An event published before a subscriber exists is never delivered to it. No deployed
   environment exists before slice 3 has merged.
3. **Scheduler lock (ADR-0006 decision 7).** "One runner per job via
   `pg_try_advisory_lock`" reads as the transaction-scoped `pg_try_advisory_xact_lock`, held
   in a transaction of the runner's own for the whole run (PA3). Prisma's pool gives no
   session affinity outside a transaction: a session lock taken through it was released on
   another connection and stayed held (verified). The lock saves cost and noise; it is not a
   correctness control, and every job is safe to run twice and concurrently.
4. **Mail transport and entry-point folders (ADR-0008 decision 2).** `platform/mail/` joins
   the cross-cutting runtime. It holds the `MailTransport` port and its adapter, which send a
   message that is already rendered, and nothing else: no templates and no business rules.
   Templates and their translation keys live in the sending module (14.1 item 5). Job and
   subscriber definitions are entry points like controllers and live in the module's
   `presentation/jobs/` and `presentation/subscribers/`; no new folder kind (PA6).
5. **Trigger reading and slice 1 (ADR-0015 decision 3).** "In the same change as" reads
   "no later than, never after": a deferred item may merge in an earlier PR of its first
   consumer's slice set, built from the same approved design, but the consumer never merges
   before it. Identity's slice 1 is delivered as slices 1a to 1d, one branch and one PR each
   (`CLAUDE.md` rule 13), and the qc-release-manager checks the decision 3 triggers on 1d
   (PA8, 14.1 item 7). The row "UnitOfWork, outbox relay, event bus, scheduler, `APP_ROLE`"
   is met by the publish path; the delivery side follows decision 2 above.

## Consequences
- A use case with slow work is written as read, slow work, write. A change between the
  read and the write is caught by the version check, never written over. "At most one
  read-write unit" is a review rule, backed by the error on a nested unit and by "no
  database access outside a unit".
- A sign-in attempt costs two write units (reservation and result), and a refused attempt
  always leaves its count behind.
- Until slice 3, events are written and relayed but reach nobody; no code may rely on
  receiving one. The first deployed environment waits for slice 3, as well as for
  ADR-0015 decision 2 and ADR-0020 decision 4.
- `sellers` uses `platform/mail/` before `notifications` exists (Phase 6); `notifications`
  will own templates and preferences and use the same port.
- Each running job holds one pooled connection for its run, bounded by its maximum run
  time.
- QC reads ADR-0015 decision 3 with this note: a trigger is met when its item merged no
  later than its first consumer, never after it.

## Alternatives considered
- One transaction around the whole use case (ADR-0004 decision 5 as written; option B of
  PA2): a connection stays pinned while a password is hashed, and a mail would be sent
  inside a transaction.
- Count attempts after verifying (the reviewed design): N parallel requests got N guesses.
- The delivery side in slice 1 with a test-only subscriber: one more PR in the largest
  slice, built before its consumer.
- A mail-request table in `identity` read by a scheduled job: needs only the scheduler, but
  builds a second retry mechanism that Phase 6 throws away.
- A session-level advisory lock on a dedicated `pg` connection outside Prisma's pool: keeps
  the ADR's wording, at the price of connection handling of our own.
- The mail transport inside `identity`: `sellers` needs the same transport before
  `notifications` exists.
- Slice 1 as one PR, so that "the same change" holds literally: four security-relevant
  mechanisms in one review.
