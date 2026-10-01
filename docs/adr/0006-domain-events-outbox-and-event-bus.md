# ADR-0006: Domain Events — Transactional Outbox and In-Process Event Bus

**Status:** Accepted — 2026-09-30 (broker approach chosen by the owner)
**Relates to:** technical-spec §1.5 (Kafka as long-term target), ADR-0004 (transactions)

## Context
Modules must communicate through public interfaces or domain events only, and events
must never be lost or published for a change that was rolled back. Running Kafka or
RabbitMQ in every Region Stack (ADR-0003) before the first sale is operational cost the
MVP does not need, but the code must be able to move to a real broker without changing
modules.

## Decision
1. **Event envelope.** Every event has: `event_id` (UUIDv7), `type` (versioned, e.g.
   `ordering.order-placed.v1`), `occurred_at` (UTC), `market_id`, `tenant_id`,
   `aggregate_type`, `aggregate_id`, `aggregate_version`, `correlation_id`,
   `causation_id`, `payload`.
   Event names never contain a vertical or market name (ADR-0001/0003).
2. **Transactional outbox.** Each module writes its events to its own `<module>.outbox`
   table in the same transaction as the state change (ADR-0004). Nothing is published
   directly from a use case.
3. **Relay.** A relay loop reads unpublished outbox rows with `FOR UPDATE SKIP LOCKED` and
   hands them to the `EventBus` port. Delivery is at-least-once; there is no ordering
   guarantee — consumers use `aggregate_version` to ignore stale events.
4. **MVP adapter: durable in-process bus.** The adapter fans each event out, in one
   transaction with marking the outbox row published, to
   `platform.event_delivery(event_id, subscriber, status, attempts, next_attempt_at)`.
   Workers process deliveries asynchronously — never inside the publishing request or
   transaction — so a crash never loses an event. Retries with backoff and dead-lettering
   (plus an alert) live in this table. Relay and handlers run in the `worker` role of the
   same image (`APP_ROLE=api|worker`).
5. **Idempotent consumers.** Each consuming module records `(event_id, handler)` in its own
   `<module>.inbox` table in the same transaction as its side effects.
6. **Contracts are public.** Event types and payload schemas live in the publishing
   module's `contracts/`; consumers import only from there. Breaking changes need a new
   version (`.v2`) and a period of publishing both.
7. **Scheduled jobs.** Zone-aware jobs (ADR-0005 decision 6: CERT-14/15, SUB-06, HLT-03)
   run in the `worker` role; one runner per job via `pg_try_advisory_lock`. Each run
   iterates `HOSTED_MARKETS` and sets an explicit market context (ADR-0003 decision 2).
8. **Swap path.** RabbitMQ or Kafka is added later as another `EventBus` adapter, chosen by
   a new ADR when a real trigger appears (extracting a module into its own service, or
   worker throughput limits). Modules, outbox and inbox do not change.

## Consequences
- No broker to run in the MVP; Docker Compose stays Postgres + Redis + MinIO + mail catcher.
  *(Amended by ADR-0016: the object-storage service is added with its first consumer.)*
- Consumers must be idempotent from day one — the same rule a real broker would need.
- Event latency is the relay's poll interval (target under 1 s); acceptable because
  cross-module reactions are asynchronous by design.
- The checkout Saga (Phase 5) is built on these events; spec §1.6 specifies choreography,
  and changing that needs its own ADR.

## Alternatives considered
- RabbitMQ from day one: one more stateful service per Region Stack with no MVP need.
- Kafka from day one: the spec's long-term target, heavy for a small team and MVP volume.
- Synchronous in-transaction handlers: couples modules' transactions, breaks extraction.
- Redis Streams/BullMQ as transport: possible later adapter; not needed while in-process.
