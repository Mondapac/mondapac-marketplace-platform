# Platform foundations — shared kernel, market context, subject keys, authorisation seams

**Author:** Mohammad (software-architect) — 2026-10-03
**Status:** Approved by the CTO, 2026-10-03 (ADR-0015 decision 3; ADR-0020), after review by
Hassan (security-tester), Mojtaba (database-designer) and Hossein (backend-developer). Slice 0
(section 7) may be coded from this document. Section 6 is a proposal to identity G2 and binds
only once G2 approves it; the fields of `ActorContext` are written back after G2.
Section 6 and 3.4 written back from identity's approved G2 design, 2026-10-03.
**Ground truth:** ADR-0001, ADR-0003 to ADR-0006, ADR-0008, ADR-0009, ADR-0014, ADR-0015 and
ADR-0018 (decision numbers are cited where used); ADR-0020 ("Platform foundations amendments",
accepted with this design; cited where a decision of section 12 needs it);
`docs/modules/identity/brief.md` (sections 3, 5, 6, 9, 11; rules R1 to R12);
`docs/design/data/platform.md`; `docs/reviews/phase-1.md`; the code on branch
`docs/platform-foundations`.

## 1. Scope

A design, not an implementation: signatures appear only where the signature is the contract.

- **Decided here:** the shared-kernel type contracts (3), the `SubjectKeyService` port (4), how
  work gets its Market and how that reaches a use case (5), slice 0 (7), placement and boundary
  rules (8), tests (9), dependencies (10).
- **Proposed to identity G2, binding once G2 approves:** all of section 6 (permission
  declaration, registry, access-rule kinds, ports, constraints on the mechanism). Brief section
  6 sets the declaration shape at G2 and ADR-0018 decision 9 leaves the mechanism to G2. Of
  section 6, only boundary rules 1 and 2 of 8.2 land in slice 0.
- **Left to identity's G2 design:** the fields of `ActorContext`, including acting-as (SEL-08);
  sessions, cookies and CSRF; which live columns are encrypted; the content of the permission
  catalogue; UnitOfWork, outbox, relay, event bus, scheduler and `APP_ROLE` (I4) and the
  `market_id` guard (I5), each a platform document under `docs/design/domain/` approved inside
  G2. Inputs: 12(b).
- **Own later trigger:** the audit writer, seal table and sealer get their own design before
  slice 6 (ADR-0015 decision 1); every other row of section 2; `Money` (ADR-0015 decision 3:
  before the first slice that handles a price; nothing in Phase 2 has one).

Numbering: **A1 to A9** are Ali's decisions (12(a)); **C1 to C6** are points he confirmed in the
final check (top of 12); **I1 to I15** are inputs to G2 (12(b)). Slices are those of brief
section 11, confirmed at G2.

## 2. ADR-0015 decision 3, row by row

| # | Deferred item | In this document | Lands |
|---|---|---|---|
| 1 | Kernel types `Id`, `Clock`, `MarketContext`, `Result`, `DomainEvent`, `ActorContext` | Designed here (3.1 to 3.7). `ActorContext`: guarantees here; fields at G2, then written back here | Slice 0 (A6): `Id`, `Clock`, `MarketContext`, `Result`, `CorrelationId`. Slice 1: `DomainEvent` (with the outbox), `ActorContext`, `CallContext` |
| 1 | ADR-0009 value types | Signatures deferred (3.8, A1; ADR-0020 puts a note on this row) | `Revision<T>`, `EffectivePeriod`: first consumer, none in Phase 2. `ContentHash`: decided in the audit-seal design (slice 6) |
| 2 | Money | Out of scope | Not in Phase 2 |
| 3 | Temporal polyfill | With `Clock` (3.2); `temporal-polyfill` 1.0.5 (A2) | Slice 0 |
| 4 | Request-level market context | Designed here (5) | Slice 0 (HTTP); job and event adapters slice 1 |
| 5 | UnitOfWork, outbox relay, event bus, scheduler, `APP_ROLE` | Identity G2 (I4). This document fixes only what they carry (3.6, 3.7, 5.1) | Slice 1 |
| 6 | `market_id` Prisma query guard | Identity G2 (I5) | Slice 1 |
| 7 | "Model to owning module" lint rule | Identity G2 (I14); named in 8.2 | Slice 1 |
| 8 | Market configuration seeded to the database | Not yet: Phase 2 reads Markets from `MarketRegistry` only (brief section 3: "approval required" is Market configuration as code) | No trigger yet |
| 9 | `config/service-areas/`, `config/holidays/` | Not yet | No trigger yet |
| 10 | Extension-point registry, `verticals/` content | Not yet. The permission registry (6.1) is a different thing | No trigger yet |
| 11 | Auth guards | Guard seam and port proposed to G2 (6.3) | Actor guard slice 1 (anonymous only); `Authenticator` slice 2 |
| 12 | Baseline HTTP hardening | Not architecture; items, owners and the security-tester's decisions in 7 | Slice 0. Rate limiting: after the G2 dependency list, before slice 1's endpoint merges. Login throttling: slice 2 |
| 13 | `infra/` | Not yet | Phase 7 |
| 14 | Redis and object-storage clients | Not yet; whether rate limiting uses Redis is G2 (I11) | First use |
| 15 | `SubjectKeyService` | Port designed here (4) | Slice 1 |
| 16 | Permission registry in `platform/` | Proposed to G2 (6.1) | Slice 8, or earlier if G2 says so |
| 17 | CI check on declared access rules | Identity G2; constraints in 6.4 | Slice 1: required by the security-tester, recommended here (C1); G2 names the slice |
| New | Market `status` semantics (row added by ADR-0020, A8) | Not designed: "hosted" is the only gate in Phase 2 | Before the first publicly reachable deployment; enforced in `MarketContextFactory` |

## 3. Shared-kernel types

All in `packages/shared-kernel/src/`, framework-free (ADR-0008 decision 1). `domain/` may import
nothing else (ADR-0015 decision 4), so every type the domain needs must be here. The kernel has
no I/O and no Node API: `eslint.config.mjs` forbids `node:*` there and its build has no Node or
DOM types (confirmed by Hossein: `process`, `Buffer` and `node:crypto` do not compile there).
Table 3.9 says what each type must never contain, who builds it and who uses it first.

### 3.1 `Id`
```ts
type Id<K extends string = string> = string & { readonly __id: K };
function parseId<K extends string>(text: string): Result<Id<K>, { readonly code: 'id.invalid' }>;
function uuidV7(unixMs: number, random: Uint8Array): string; // pure RFC 9562 layout, 10 bytes
interface IdGenerator { next<K extends string>(): Id<K> }
```
The identifier of every record and event (ADR-0003 decision 6, ADR-0004 decision 4): the
canonical lower-case text of a version 7 UUID, one to one with a `@db.Uuid` column (PostgreSQL
prints `uuid` in lower case and uuid order equals text order; checked by Mojtaba). `parseId`
rejects every other spelling and version. Ordered by creation time to the millisecond, with
**no** order inside one: nothing may rely on id order for correctness (ADR-0006 decision 3 uses
`aggregate_version`). The brand `K` is compile-time only. Ids come only from an injected
`IdGenerator`; the production one is in `platform/ids/` (Clock time, `node:crypto` random bytes).

### 3.2 `Clock` and the Temporal types
```ts
export { Temporal } from 'temporal-polyfill'; // the only import of the polyfill in the repository
interface Clock { now(): Temporal.Instant }
```
The only source of the current time (ADR-0005 decision 5, ADR-0008 decision 4). ADR-0005's
names map to Temporal's with no alias layer (`LocalDate` = `PlainDate`, `LocalTime` =
`PlainTime`); the 60 minutes of SEL-05 are a `Temporal.Duration`. `now()` is an instant with no
zone, truncated to the millisecond (Prisma carries `Date`), so it survives `timestamptz(6)`,
JSON and a UUIDv7 timestamp unchanged. A local date needs the IANA zone of the owning party,
passed explicitly (ADR-0005 decision 3). The kernel installs no global `Temporal`: all code
imports it from the kernel, so moving to native Temporal changes one file. Every stored instant
comes from `Clock`: no column default and no SQL `now()` (microseconds); SQL that compares with
the current time takes the Clock instant as a parameter. Repositories convert `Instant` to and
from `Date` with `new Date(value)` (rule 4 of 8.2 allows it outside `domain/` and `application/`).

### 3.3 `MarketContext`
```ts
type MarketId = string & { readonly __brand: 'MarketId' }; // ^[A-Z][A-Z0-9_]{1,7}$
type TenantId = string & { readonly __brand: 'TenantId' }; // ^[a-z][a-z0-9-]{1,31}$
interface MarketContext { readonly marketId: MarketId; readonly tenantId: TenantId }
```
The Market and tenant a piece of work belongs to (ADR-0008 decision 5): both present, well
formed, immutable, minted (3.7). The Market pattern is already written twice
(`platform/config/app-config.ts`, `platform/market-config/market-config.ts`); the kernel's
`parseMarketId` becomes its single definition, and it fits `market_id varchar(8)`. The kernel
guarantees shape only: "hosted by this Region Stack" is guaranteed by the single production
constructor in `platform/market-context/` (5.1).

**Tenant (A5).** The tenant is a seam only (ADR-0001 decision 2). Its value is one named
constant in `platform/market-context/`, provided through an injection token so tests can
override it: no environment variable, no `AppConfig` field, nothing in `.env.example` or CI. A
mistyped environment value would write mixed rows unnoticed, because no key or constraint
includes the tenant. ADR-0001's "defaulting" and ADR-0004 decision 4's "seeded" both mean
"supplied by the application". Column rule (Mojtaba): `tenant_id text NOT NULL`, no database or
Prisma default, in no key or index; new tables mirror both patterns as CHECK constraints.

### 3.4 `ActorContext`
```ts
type ActorContext = AnonymousActor | SystemActor | AuthenticatedActor;
// AnonymousActor: { kind: 'anonymous'; marketId }   SystemActor: { kind: 'system'; marketId }
type Population = 'customer' | 'seller' | 'admin'; // 'seller' = Seller Owner and Staff
interface AuthenticatedActor {
  readonly kind: 'authenticated';
  readonly marketId: MarketId; // the Market of the account and of the session
  readonly population: Population;
  readonly accountId: Id<'Account'>;
  readonly sessionId: Id<'Session'>; // an id, never the token
  readonly sellerId: Id<'Seller'> | null; // set if and only if population is 'seller'
}
```
Who is acting, as identifiers (ADR-0018 decision 4). Whatever fields G2 gives it:

| # | Guarantee of the kernel type, and what stays open |
|---|---|
| 1 | A closed union on `kind`. Anonymous is an explicit value: `undefined` or `null` is never an actor, and no kind is a default |
| 2 | Every kind carries the `marketId` it was established in; with a `MarketContext` of another Market it is refused (5.2) |
| 3 | Identifiers and enumerations only. Roles and permissions are read by `identity` on every request (ADR-0018 decision 2, R4); they do not travel in the context |
| 4 | Minted (3.7). Anonymous and system actors are built by `platform/` entry adapters; authenticated actors only by `identity`'s implementation of the port in 6.3, in one file |
| 5 | The system kind has no account id (`platform.audit_log`: `SYSTEM` rows have no `actor_id`). For acting-as, the real admin stays the actor and the impersonated account is an extra identifier (`docs/design/data/platform.md` 3.2); nothing more is decided here |
| 6 | Decided at identity G2 (I1): `kind: 'authenticated'`, `marketId`, `population` (`customer`, `seller` or `admin`), `accountId`, `sessionId` (an id, never the token) and `sellerId` (set if and only if the population is `seller`, from the active membership). Roles, permissions, seller state and second-factor status never travel in it; `actingAs` is reserved for SEL-08. Its rules: identity design section 4. |

### 3.5 `Result`
`type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }` (fields read-only), with
`ok()` and `err()`: expected failures as values. No combinator library, no throwing `unwrap`.
`E` is a closed union with a stable `code` (brief section 6: the API returns state codes, not
message text). Exceptions remain for programmer errors and infrastructure failures.

### 3.6 `CorrelationId` and `DomainEvent`
`CorrelationId` is a branded string matching `^[A-Za-z0-9._-]{8,128}$`, the rule that exists in
`platform/logging/correlation-id.ts` and in `audit_log_correlation_id_check`; the kernel becomes
its single definition. **The API always generates the id (C3).** Today the caller's
`x-correlation-id` is accepted, and this design would carry it into immutable audit rows and
events: up to 128 caller-chosen characters that can never be erased. From slice 0 an inbound
value that fits the pattern is logged once as `clientRequestId` and goes nowhere else; the
generated id is returned in the response header as today. Cost: a caller can no longer choose
an end-to-end id; it correlates through the response header or `clientRequestId`.

`DomainEvent` (slice 1, with the outbox: A6) is the envelope of ADR-0006 decision 1, field for
field, in camel case, with no actor field (ADR-0018 decision 4):

| Field | Contract |
|---|---|
| `eventId`, `causationId`, `aggregateId` | `Id`s; `causationId` is the consumed event that caused this one, or `null` |
| `aggregateType` | The aggregate's type name, a constant of the publishing module; no market or vertical name |
| `type` | `<module>.<subject>-<past participle>.v<N>`; starts with the publishing module's name |
| `occurredAt`, `market`, `correlationId` | A `Temporal.Instant`; `market_id` and `tenant_id` as one `MarketContext`; a `CorrelationId`. Whether the aggregate or the outbox writer stamps them is decided with the outbox (I4) |
| `aggregateVersion` | Fits 32 bits, starts at 1, is the aggregate's optimistic-lock column; no two events of one aggregate share a value (I7) |
| `payload` | A plain JSON object that must survive `jsonb`: no reliance on key order, no integer above 2^53, instants as ISO strings. No type can keep personal data out of it (ADR-0009 decision 6, R5): payload schemas live in the publisher's `contracts/` (ADR-0006 decision 6), a contracts test fails any free-string payload field, and security review checks them |

### 3.7 Minted contexts and constructors (C2)
A module can write a context as an object literal and it compiles (verified by Hassan with
`{ kind: 'system', marketId: … }`), so an import rule alone protects nothing. `MarketContext`,
`ActorContext` and `CallContext` are therefore **minted**: each type carries a brand whose symbol
the kernel does not export, each value is frozen, and the kernel records every value it creates
in a private `WeakSet`. `isMinted(value)` is the only question other code can ask.
`platform/authz` and the UnitOfWork refuse a context that was not minted; rule 5 of 8.2 forbids
the constructor imports and `as` assertions to these types in modules. Cost: a context cannot
be rebuilt from JSON or copied with a spread, so every entry adapter (HTTP, job, consumed
event) goes through the factory of 5.1, and one process must load one copy of the kernel. Tests get
contexts from builders on the `/testing` subpath, which call the same mint functions; the main
entry and `/testing` must resolve to one build of the kernel, and a test proves that a context
built there passes `isMinted` in `platform/`.

| Kernel function | Called by | On bad input |
|---|---|---|
| `parseId`, `parseMarketId`, `parseTenantId`, `parseCorrelationId` | Anyone, on untrusted text | Return a `Result` error |
| `uuidV7(unixMs, random)` | The id generators | Throws `RangeError`: a time outside 48 bits or not 10 bytes is a programmer error |
| `mintMarketContext(marketId, tenantId)` | `MarketContextFactory` only | Takes parsed values; cannot fail |
| `anonymousActor(market)`, `systemActor(market)` | `platform/` entry adapters | Throw on a `MarketContext` that was not minted |
| `authenticatedActor(market, …)` (slice 2, fields at G2) | One file of `identity` | Throws, as above |
| `createCallContext(market, actor, correlationId)` (slice 1) | Entry adapters | Throws `ContextMismatchError` when the actor's Market differs or a part was not minted; the adapter turns it into a denial |

### 3.8 ADR-0009 value types and `Money`
`Revision<T>`, `ContentHash` and `EffectivePeriod` have no consumer in Phase 2 that fixes their
shape: the brief names no revisioned (V1) or effective-dated (V2) entity in `identity`, and link
and session lifetimes are durations checked against `Clock`. **Decision A1: their signatures are
not designed now.** `ContentHash` is decided in the audit-seal design (slice 6); the other two
in the G2 of their first consumer. ADR-0020 records this as a note on ADR-0015 decision 3 row 1.
What ADR-0009 fixes stays binding: immutable revision content with `revision_no` and
`content_hash` (decision 2); hashes over personal fields keyed with the subject's key or computed
over ciphertext (decision 6); `valid_from` and `valid_to` with the database no-overlap constraint
(decision 2). `Money` is out of scope: it has its own trigger.

### 3.9 What a type must never contain, who builds it, first consumer
| Type | Must never contain | Built by | First consumer |
|---|---|---|---|
| `Id` | A secret or token: it shows its creation time and has 74 random bits; session tokens, links and invitations are separate random values (G2). A market, tenant or type. An external system's id (those are plain strings) | An injected `IdGenerator` | Slice 1: account id, `event_id` |
| `Clock`, Temporal | A zone, a `today()` or a Market default; `Date` in any kernel signature | `platform/clock/` | Slice 0: id generator. Slice 1: timestamps, link expiry |
| `MarketContext` | A default; a locale, currency or time zone (Market configuration, read from `MarketRegistry` by `marketId`); a vertical; an actor; a host name | `MarketContextFactory` only (3.7, rule 5 of 8.2) | Slice 0: request context |
| `ActorContext` | An email, a name, a role name, a permission list, a session token, an IP address, a user agent | `platform/` entry adapters; one file of `identity` for authenticated actors | Slice 1: anonymous registration |
| `Result` errors | Personal data, free text or message text: errors reach logs | Any code | Slice 0: the parse functions |
| `CorrelationId` | A caller-chosen value (C3); anything outside its pattern | `platform/logging/`, always generated | Slice 0: request logging |
| `DomainEvent` | An actor; personal data; a free-string payload field such as a reason or a role name; a market or vertical name in `type` | The publishing module; stamping per I4 | Slice 1: the outbox |

## 4. `SubjectKeyService` port

Purpose (ADR-0009 decisions 6 and 8): personal fields become unreadable for ever when one key
per person is destroyed, while history and hash chains stay intact (VER-13).
```ts
type FieldLabel = string & { readonly __brand: 'FieldLabel' }; // '<module>.<record>.<field>'
type HashPurpose = string & { readonly __brand: 'HashPurpose' };
type Keyed<T> = Promise<Result<T, { readonly code: 'subject-key.destroyed' }>>;
interface SubjectKeyService {
  createKey(market: MarketContext, subject: Id): Promise<void>;
  encrypt(market: MarketContext, subject: Id, field: FieldLabel, plain: string): Keyed<string>;
  decrypt(market: MarketContext, subject: Id, field: FieldLabel, cipher: string): Keyed<string>;
  hmac(market: MarketContext, subject: Id, purpose: HashPurpose, data: Uint8Array): Keyed<string>;
  destroyKey(market: MarketContext, subject: Id): Promise<void>;
}
```

| # | Guarantee of the port, whatever the adapter |
|---|---|
| 1 | **One data key per subject**, generated inside the service and stored only wrapped under the Region Stack's wrapping key (one regional key, not one per subject). A subject has exactly one data key for life in Phase 2. No operation returns a key; key material and plaintext never reach logs, errors, events or audit rows |
| 2 | **Bound, randomised ciphertext.** Encryption is authenticated and bound to the `marketId`, the subject and `field`: a value copied to another subject, field or Market does not decrypt. The tenant id is not bound. Encryption is randomised, so ciphertext is never compared, indexed or unique. The ciphertext names its format version only; the wrapping-key version is recorded on the key row, so rotation rewrites key rows and no module table |
| 3 | **Labels are constants.** `field` and `purpose` are branded constants declared in the owning module's `infrastructure/`, never built from input |
| 4 | **Keyed hashes.** `hmac` uses a key derived from the data key and separated by `purpose`: the encryption key is never the hash key, and hashes of different purposes cannot be compared. The output cannot back a UNIQUE constraint or an equality search across subjects: "find the account with this email" cannot use it (I6). It is designed now and built with its first consumer; none is named in Phase 2 |
| 5 | **Explicit life cycle.** `createKey` fails if the subject ever had a key: the primary key on the subject refuses a second one. `destroyKey` is an update that removes the key material and keeps the row as a tombstone; it is idempotent. A destroyed subject never gets a new key silently |
| 6 | **After destruction** the three data operations return `subject-key.destroyed` as a value and callers show an "erased" placeholder. A subject that never had a key is a programming error and throws |
| 7 | **A failure is never an erasure.** A wrapping-key or unwrap failure, and a failed authentication tag, throw. They are never reported as `subject-key.destroyed`, and encryption never falls back to plaintext. Otherwise a key-service outage would show living people as erased |
| 8 | **Inside the caller's UnitOfWork.** `createKey` and `destroyKey` write in it (platform infrastructure, like the audit write of ADR-0004 decision 7): an account never commits without its key and an erasure never half-happens. `encrypt`, `decrypt` and `hmac` read the key row through it when one is open, so registration reads its own uncommitted key |
| 9 | **No cache of unwrapped keys across requests** in Phase 2: a key destroyed by one process must not stay usable in another (the reasoning of ADR-0018 decision 2). Cost: one unwrap per operation |
| 10 | **`KeyWrapper`** (`wrap`, `unwrap`) takes a binding context (market, subject, key version), so a wrapped key moved to another row does not unwrap. The local and CI stand-in refuses to start in production |
| 11 | **Not the port's job:** deciding whether erasure is allowed (legal retention follows the Market's retention configuration first; CUS-03 is P2), and erasing backups (ADR-0009 decision 6) |
| 12 | **Algorithms** (Hassan; final at G2 with test vectors on the minimum Node version): AES-256-GCM with a random 96-bit nonce and `authTagLength: 16` on both sides; HKDF-SHA-256 subkeys with separate encryption and hash labels; length-prefixed associated data; HMAC-SHA-256, untruncated; a versioned envelope |
| 13 | **Placement:** the port, the service and `KeyWrapper` in `platform/subject-keys/`; the Prisma store of the key table in `platform/persistence/`, behind an interface declared in `platform/subject-keys/`, so the existing persistence rules stay unchanged |

| Not decided here | By whom |
|---|---|
| The key table. Accepted: `platform` schema, text ciphertext. Required: no `DELETE` for the application role and a trigger that makes the tombstone one-way. Needed first: what a subject is, the wrapped-key size and wrapping-key identifier, the rotation procedure, tombstone retention (I6) | Mojtaba, in identity's G2 data design |
| The wrapping key, its storage and rotation, and the stand-in behind `KeyWrapper` | Kazem |
| Which live columns are encrypted (ADR-0009 decision 6 binds history fields only); whether the subject id is the account id; whether registration creates the key even when no column is encrypted yet (recommended: yes, otherwise early accounts have no key). First consumer: slice 1 | Identity G2 |

## 5. Request-level market context

### 5.1 Resolution
Today nothing resolves a Market per request. `MarketRegistry` (`platform/market-config/`) knows
the hosted Markets and throws `MarketNotHostedError` for any other, `HOSTED_MARKETS` is required
with no default, and `MarketConfig` has no host field. One factory in
`platform/market-context/`, `MarketContextFactory.forMarket(code)`, becomes the only production
constructor of a `MarketContext`: it validates the code, asks `MarketRegistry`, adds the tenant
constant, mints the context and returns a `Result`. It never substitutes a Market, and "hosted"
is its only gate in Phase 2 (A8). Three entry adapters call it:

| Entry | Market comes from | Lands |
|---|---|---|
| HTTP request | The request header `x-market-id` (A4) | Slice 0 |
| Scheduled job | Iteration over `MarketRegistry.hostedMarketIds()`, one run per Market (ADR-0006 decision 7), as that Market's system actor with its own correlation id; one Market's failure does not stop the others | Slice 1 (I4) |
| Consumed event | The envelope's `market` and correlation id (ADR-0003 decision 7), as the system actor; a Market not hosted here is dead-lettered | Slice 1 (I4) |

**HTTP source (A4, decided).** ADR-0003 decision 2 names "host/domain mapping; explicit header
for API clients". The API takes the header only. ADR-0020 decision 3 amends ADR-0003 decision 2:
host/domain mapping is the job of the tier in front of the API (BFF, panel server or edge;
ADR-0001 decision 4), which overwrites any client-supplied header.

| Option | For | Against |
|---|---|---|
| A (chosen). Header only at the API; whatever serves a host maps host to Market and sends the header | Works today; needs no domain decision (the launch playbook's domain strategy is open); one code path | A browser calling the API directly must send the header itself |
| B. Host mapping inside the API, plus the header | Covers direct browser calls | Needs a `hosts` field in Market configuration, a trust-proxy decision and the open domain strategy |

**Guard.** `MarketContextGuard` reads the header and attaches the `MarketContext` to the
request. All global guards are `APP_GUARD` providers in one array in `app.module.ts`,
`MarketContextGuard` first; no other module declares `APP_GUARD`; a test asserts the list and
its order. A request that fails here never reaches `Authenticator`, whatever credential it
carries, and nothing is read from the database.

| Case | Answer |
|---|---|
| No header | 400 `{ statusCode: 400, code: 'market.header-missing' }` |
| A malformed value, or a repeated header (Node joins it into one string, which fails the pattern) | 400 with code `market.header-invalid` |
| A well-formed Market that is not hosted | 400 with code `market.not-hosted` |

| Topic | Rule |
|---|---|
| Body | The code only: the received value is never echoed and never logged. The shape `{ statusCode, code }` is fixed for these three answers; the full error format stays I12, which may add fields but not rename these |
| Front tier | Whatever fronts the API overwrites any client-supplied `x-market-id`. If option B is added later, through the same factory, a header and a host that disagree are refused |
| Not a privilege | The header is not a privilege and not a CSRF defence: a Market is not a secret, a session or link of one Market is refused in another with the same answer as an unknown token (brief section 5), and a Market outside `HOSTED_MARKETS` is always refused |
| Caching | Every API response carries `Cache-Control: no-store` (item 6 of section 7), because answers depend on a request header |
| Exemption | A `@NoMarketContext()` decorator (`Reflector.createDecorator`) that only the guard file and `platform/health/` may import (rule 6 of 8.2). `/docs`, `/docs-json` and the Swagger assets are served outside Nest routing with no guard call, and an unmatched route answers 404 with no guard call (both verified by Hossein). Every new controller is therefore market-scoped by default |
| Reading it | The `@Market()` parameter decorator throws when no context is attached; it never defaults |
| OpenAPI | `openapi.ts` adds `x-market-id` as a required header parameter to every operation after the document is built, skipping the operations of controllers that carry the exemption metadata (the same `Reflector` key the guard reads). A global parameter is not used: it would also mark `/health`. A test asserts both cases |
| Modules | `ClockModule`, `IdsModule` and `MarketContextModule` are `@Global()`, like the existing `ConfigModule`, `MarketConfigModule` and `PersistenceModule`; they export tokens and the factory only |

### 5.2 How it reaches a use case
| Option | For | Against |
|---|---|---|
| A (chosen). Explicit: the entry adapter builds the context once and passes it as an argument | The wording of ADR-0018 decision 4 and ADR-0008 decision 5; visible in signatures; the same for HTTP, jobs, event handlers and later AI tools; forgetting it is a compile error | One more parameter everywhere |
| B. Ambient store (`AsyncLocalStorage`) read where needed | Less plumbing | A hidden input; a lost async context becomes a wrong or missing Market at run time; close to the "ambient market" that ADR-0008 decision 5 rules out |
| C. Nest request-scoped providers | Idiomatic | Makes the whole provider chain request-scoped; jobs and event handlers have no request |

`AsyncLocalStorage` stays where ADR-0004 decision 5 puts it (the UnitOfWork) and in logging; it
is never the source of the Market for business code, and modules get no `current()` accessor.
The context is one minted kernel value (A3; ADR-0020 adds it to the list of ADR-0008 decision 1):
```ts
type CallContext = { market: MarketContext; actor: ActorContext; correlationId: CorrelationId };
```
| # | Rule |
|---|---|
| 1 | Every use case and facade method takes a `CallContext` first (ADR-0018 decision 4: an `ActorContext` and a `MarketContext`; ADR-0008 decision 5: plus the correlation id) |
| 2 | Repositories and `SubjectKeyService` take the `MarketContext` only. The audit writer, the outbox writer and the authorisation port take the `CallContext`; the audit writer derives the actor columns itself and accepts none from its caller (ADR-0004 decision 7) |
| 3 | `createCallContext` refuses an actor of another Market: "valid only in its own Market" is enforced once, not in every use case. No code replaces the actor of a `CallContext` it received |
| 4 | **Who attaches the actor:** a guard, second in the `APP_GUARD` array. In slice 1 it attaches the anonymous actor of the resolved Market; from slice 2 it calls `Authenticator` (6.3). A parameter decorator then builds the `CallContext` and throws when the Market or the actor is missing, so no controller ever defaults one |

## 6. Authorisation seams in `platform/` (proposal to identity G2)

**Status: approved at identity G2, 2026-10-03, with the changes of `docs/design/domain/identity.md` 5.1 (6.2 row 1, 6.3).** The mechanism is identity design 5.2.
Everything lives in `platform/authz/`. `platform/` imports no module (ADR-0018 decision 4);
nothing enforces that today, and rule 1 of 8.2 does from slice 0.

### 6.1 Permission declaration and registry
```ts
interface PermissionDeclaration {
  readonly key: PermissionKey; // '<module>.<resource>.<action>'
  readonly scope: 'platform' | 'seller'; // exactly one (R2); there is no customer scope
  readonly protected: boolean; // R11; always written out, there is no default
}
```
A key is three lower-case segments (`^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$`); the first is the
declaring module's name. No Market, no vertical (R7) and no display text: labels are translation
keys derived from the key (INTL-11). A permission needed in both panels is two declarations.
Declarations are constants in the owning module's `contracts/`, made through one helper that
validates and brands the keys; use cases refer to the constants, never to literals.

| # | Guarantee of `PermissionRegistry` (`register(module, declarations)`, `get(key)`, `list(scope?)`) |
|---|---|
| 1 | Modules push their declarations at bootstrap; the registry imports nothing. Boot fails on a duplicate key, a malformed key, or a key whose first segment is not the registering module |
| 2 | It is sealed when bootstrap completes: `register` afterwards throws, and `get` and `list` throw before sealing. The catalogue is the same in every process of one build (`api` and `worker`) |
| 3 | An unknown key grants nothing: `get` returns nothing and every caller treats that as a denial (R7, acceptance criterion 36). A key removed from code stops granting at the next deploy |
| 4 | **Retired keys (C4).** A removed key goes on a checked-in retired list, and declaring a retired key again fails boot: otherwise roles that still hold the old key would gain a new permission without an explicit edit (R10) |
| 5 | It holds the code catalogue only: no roles, no assignments, no Market data, no database. `identity` reads the catalogue only from here (R7), never from another module's `contracts/` |

### 6.2 Access-rule kinds
```ts
type AccessRule =
  | { readonly kind: 'permissions'; readonly allOf: readonly [PermissionKey, ...PermissionKey[]] }
  | { readonly kind: 'anonymous' } // no authentication required
  | { readonly kind: 'own-resources' } // an authenticated actor, on what its own account owns
  | { readonly kind: 'system' }; // the system actor only; never satisfiable from HTTP
```
A closed set, one rule per use case (ADR-0018 decision 4). Adding a kind, or an "any of", changes
the closed set: a CTO decision that amends ADR-0018 decision 4.

| # | Semantics |
|---|---|
| 1 | The system actor satisfies only `system`. `anonymous` means "no authentication required": it admits the anonymous actor and an authenticated one, never the system actor, and `platform/authz` passes the Market's anonymous actor to the use case, so nothing branches on, or is audited as, a signed-in visitor (identity G2). `permissions` needs an authenticated actor that holds every listed key |
| 2 | `own-resources` covers what the acting account itself owns; in Phase 2 that is its credentials, sessions and second factor. Resources of a seller or of the platform always need `permissions`: otherwise the limits of a Staff or admin role are bypassed. A customer account's later resources join this kind at that module's gate (C6) |
| 3 | `platform/authz` decides `anonymous`, `system` and the Market comparison itself. The `AuthorisationCheck` port is called only for authenticated actors |
| 4 | No kind replaces the ownership check inside the use case (R6) |
| 5 | **One list (C4).** Every declaration that is not `permissions` sits in one checked-in list; a new entry fails CI until that list changes, so each one is seen in review |

### 6.3 Ports that `identity` implements
```ts
type Rejected = { readonly code: 'credential.rejected' };
interface Authenticator {
  authenticate(
    market: MarketContext,
    credential: { token: string; transport: 'cookie' | 'bearer' } | undefined,
  ): Promise<Result<AnonymousActor | AuthenticatedActor, Rejected>>;
}
interface AuthorisationCheck {
  check(context: CallContext, rule: AccessRule): Promise<AccessDecision>;
}
```
| # | Rule for the ports |
|---|---|
| 1 | `platform/authz/` declares the interfaces and their injection tokens. `IdentityModule` provides and exports the tokens; `app.module.ts` imports it and declares the guards. Tests provide fakes. This needs no global module and no import from `platform/` into a module. Once introduced (slice 2), both ports are required at start in both `APP_ROLE`s: an unbound token fails boot (verified by Hossein), and `platform/` ships no fallback |
| 2 | The actor guard is generic platform code: it runs after `MarketContextGuard`, calls `Authenticator` and attaches the `ActorContext`. It never authorises (ADR-0018 decision 4), and it refuses an actor whose Market is not the request's |
| 3 | **Fail closed.** No credential gives the anonymous actor. A credential that is unknown, expired, revoked or from another Market gives one `credential.rejected` result, identical for all four causes, never the anonymous actor. An infrastructure failure throws and yields no actor. The return type excludes the system actor |
| 4 | Both implementations read committed state on every call and cache nothing (ADR-0018 decisions 2 and 3) |
| 5 | `AccessDecision` is "allowed", or "denied" with a reason code. The reason codes are those of identity design 5.2. `credential` names its transport, the session cookie (`cookie`) or `Authorization: Bearer` (`bearer`); a session issued for one transport is refused on the other, and Phase 2 refuses every `Authorization` header (identity design 6.2) |

### 6.4 Constraints on the G2 enforcement mechanism and its CI check (I2)
| # | Not designed here. This foundation requires that: |
|---|---|
| 1 | There is one mechanism, in `platform/authz/`, and it wraps the use case itself, because it must run for HTTP, event handlers, jobs, facade calls and later AI tools. A controller decorator or guard cannot be that mechanism |
| 2 | Controllers, event handlers, job handlers and facade implementations reach `application/` only through the wrapped use case; dependency-cruiser fails their import of a repository (rule 9 of 8.2) |
| 3 | The rule is static data attached to the use case, readable without running it, and use cases are discoverable by a path or naming convention; otherwise no CI check can list them |
| 4 | A missing rule fails CI and is a denial at run time; an error while evaluating is a denial. The mechanism refuses a context that was not minted (3.7) and compares the actor's Market with the `MarketContext` before anything else |
| 5 | A rule naming a key the registry does not know fails at boot. Every key of one rule is in one scope, and a key's scope is compared with the actor's population on every check (R2) |
| 6 | "Available to a seller that is not approved" (brief decision 6) is an attribute of the declaration, not a fifth rule kind |
| 7 | Every denial is logged with the use case, the rule, the actor id and the correlation id |
| 8 | **Slice (C1).** The CI check in slice 1 is required by the security-tester (his G1 condition: slices 1 to 7 cover sign-in, sessions, reset and the admin second factor) and recommended by this design. ADR-0018 decision 6 lets G2 name the slice; G2 cannot name a later one without the security-tester's agreement |

## 7. Slice 0

Each item is its own branch and PR (`docs/process/parallel-tracks.md`). Items 5 to 7 are not
architecture and are not designed here; the decisions the reviewers owed are recorded.

**Order.** Item 7 starts first (longest lead; one migration PR open at a time). Then items 1,
2, 3, 4 in that order; 5 then 6, after 1. The role and grant note is approved before item 7's
PR, and item 7 merges before the first slice 1 migration. Slice 1 starts only when items 1 to 7
are merged and Hassan has reviewed items 5 to 7.

| # | Item | Size | Owner | Decisions recorded |
|---|---|---|---|---|
| 1 | Dependency PR: `temporal-polyfill` 1.0.5, pinned exactly, in `packages/shared-kernel`, with `--experimental-vm-modules` in the kernel's `test` script; `helmet` in `apps/api` | S | Hossein | A2. The PR shows kernel tests, api tests through the kernel, `pnpm build` and `node dist/main` passing on the minimum Node version, and lists the transitive dependencies (`temporal-spec`, `temporal-utils`). If a check fails, fall back to `@js-temporal/polyfill` without a new approval (it needs no script change) |
| 2 | Kernel: `Result`, `Id`, `Clock`, `MarketContext` with minting, `CorrelationId`; the fakes and context builders on the `/testing` subpath; unit tests (9). Not `DomainEvent` | M | Hossein; Hassan reviews the minting code | A3, A6; C2 |
| 3 | `platform/clock/`, `platform/ids/`, `platform/market-context/` (factory, tenant constant and token, guard, decorators), the guard array in `app.module.ts`, the header in OpenAPI, the generated correlation id (C3), `rootDir: "../.."` in `apps/api/tsconfig.json`, the root `dev` script, the market tests of 9 | L | Hossein; Hassan reviews the guard PR | A4, A5, A8; C3. Without the `rootDir` change the first kernel import fails `pnpm typecheck` (TS6059); `nest build` and `pnpm dev` need the kernel's `dist/`, so `dev` builds the kernel first |
| 4 | Boundary rules 1 to 8 of 8.2 with fixtures, and the carried items of `docs/reviews/phase-1.md`: a test on `PersistenceModule` exports, a positive fixture for `domain/` importing the kernel (it needs a `paths` entry in `boundary-fixtures/tsconfig.json`), a `no-circular` fixture | M | Hossein | A7, A9 |
| 5 | Logging before body parsing (Security L4) | S–M | Hossein | Hassan: log method, path, status, correlation id, error type and content length; never `err.body` or `err.message` (body-parser puts the raw body on the error). `bodyParser: false` belongs in the shared setup, not only in `main.ts`. Wiring: C5. Before merge, tests show that a line logged outside a request is emitted as JSON through the same serializers, that an error logged there carries no `body`, and that the query-string and rejected-body tests pass on the new wiring |
| 6 | HTTP hardening and the header assertion in the CI boot probe | M | Hossein; Kazem for the CI step | Hassan: `helmet` before the parser and the guards; JSON parser only, 64 KiB, strict; HSTS two years, `nosniff`, CSP `default-src 'none'; frame-ancestors 'none'` (relaxed only on `/docs`), `Referrer-Policy: no-referrer`, `Cache-Control: no-store`; no CORS middleware until origins exist, then an exact-match list; trust proxy off, later a hop count, never `true`. The probe asserts the headers on `/health`, on a 404 and on the 400 of 5.1 |
| 7 | Database role separation (ADR-0015 decision 2) | L, cross-role | Kazem (roles created by cluster bootstrap, never in a migration; two connection URLs), Mojtaba (grant half of the note as a new section of `docs/design/data/platform.md` closing Q3; a grants migration with `down.sql`), Hossein (configuration, test harness), Hassan (review) | The note is approved by Ali and reviewed by Hassan before the PR. The application role is not a superuser, not a member of the owner role and has no `CREATE`; it gets explicit per-table grants in each migration and never sees the migration URL. `pnpm test:db` runs as that role and proves that `UPDATE`, `DELETE`, `TRUNCATE`, `DISABLE TRIGGER`, `SET session_replication_role` and `SET ROLE` all fail; the trigger test moves to an owner connection |

Not in slice 0: `DomainEvent`, `ActorContext` and `CallContext` (slice 1); any `identity` code;
rate limiting (after the G2 dependency list, before slice 1's endpoint merges; login throttling
stays in slice 2); `docker compose up -d --wait` in CI (Kazem; proposed in
`docs/reviews/phase-1.md`, not decided).

## 8. Placement and boundaries

### 8.1 Layout
```
packages/shared-kernel/src/
  index.ts (named exports only)  result.ts  id.ts  time.ts  market-context.ts
  correlation-id.ts  minted.ts                                                       slice 0
  testing.ts (FixedClock, SequenceIdGenerator; subpath `/testing`, tests only)       slice 0
  domain-event.ts  actor-context.ts  call-context.ts                                 slice 1
apps/api/src/platform/
  clock/  ids/      SystemClock, UUIDv7 generator, their tokens                      slice 0
  market-context/   factory, tenant constant and token, guard, decorators            slice 0
  subject-keys/     SubjectKeyService, KeyWrapper, store interface                   slice 1
  authz/            permission types, registry, access rules, ports                  see 2
  persistence/      existing, plus subject-key store, UnitOfWork, outbox             slice 1
  config/  health/  logging/  market-config/                                         existing
```
The `/testing` subpath resolves through an `exports` entry in the kernel's `package.json`
(`.` and `./testing`), mirrored by a `paths` entry in `apps/api/tsconfig.json` and a
`moduleNameMapper` entry in the api jest configurations.

### 8.2 Boundary rules
Checked first: `domain-is-pure` already whitelists the kernel, and a `domain/` file that imports
`@mondapac/shared-kernel` passes it (verified, section 10). It needs no change.

| # | Rule | Tool | From → to | Why, and notes from the review |
|---|---|---|---|---|
| 1 | `platform-does-not-import-modules` (new) | dependency-cruiser | `src/platform/` → `src/modules/`, `index.ts` included | ADR-0018 decision 4. Today `module-internals-are-private` still allows the import through `index.ts` (verified). The existing fixture `platform/reaches-into-module.ts` will then report two rules |
| 2 | `identity-imports-no-module` (new; allow-list starts empty) | dependency-cruiser | `src/modules/identity/` → any other module | R7 binds from the first `identity` code, so the rule lands in slice 0 (A7, A9). `legal` joins the list only by a named decision at the `legal` gate. Not yet run against a fixture |
| 3 | `temporal-only-through-kernel` (new) | dependency-cruiser | `apps/api/src/` → the polyfill | ADR-0015 decision 4. The pattern must match the bare specifier: pnpm does not resolve the polyfill from `apps/api`, so there is no path to match |
| 4 | `no-wall-clock` (changed) | ESLint | See right | Zero-argument `new Date()`, `Date.now()` and `Temporal.Now` are forbidden in all core code except `platform/clock/`. `new Date(value)` stays forbidden in `domain/` and `application/` only, so repositories can convert (3.2). Today the selector bans every `new Date(...)` and covers `domain/` only; the message text and its assertion in `boundaries.spec.ts` change |
| 5 | `contexts-are-minted-by-platform` (new) | ESLint | `src/modules/` → `mintMarketContext`, `MarketContextFactory`, the actor constructors, `createCallContext`; and `as` assertions to the context types | 3.7. The factory is exported globally (5.1), so without this a module could inject it and mint another hosted Market's context; operator routines (I10) receive their context from a `platform/` entry adapter. In slice 0 the rule covers `MarketContext` and the factory; it covers the actor and `CallContext` constructors in the PR that adds them. The exception is one file of `identity` and the authenticated constructor only. A cast object literal is not caught by lint; the minted check of 3.7 is the run-time control |
| 6 | `market-exemption-is-platform-only` (new) | dependency-cruiser | Anything but the guard file and `platform/health/` → the `@NoMarketContext()` file | ADR-0015 decision 3: only health and docs are exempt. An allow-list of importers, because a barrel re-export escaped the "outside `platform/`" form |
| 7 | Kernel imports (changed) | ESLint | Kernel → anything but itself; `time.ts` alone may import the polyfill | Today a deny-list that misses bare Node built-ins and relative paths out of the package. Written as a `regex` whitelist with a separate block for `time.ts`; the kernel glob does not match the fixture tree, so the fixture needs its own block |
| 8 | `kernel-testing-only-in-tests` (new) | dependency-cruiser | `src/` (spec files are already excluded) and the kernel's own non-test files → the `/testing` subpath | Fakes must never be bound in a running process |
| 9 | `use-cases-are-the-only-way-in` (proposed to G2) | dependency-cruiser | `presentation/`, event handlers, job handlers, facade implementations → repositories | 6.4 row 2. Lands with the access-rule mechanism |
| 10 | "Model to owning module" rule; `market_id` guard | — | — | Already triggered by ADR-0015 for slice 1; designed at G2 (I14, I5) |

Note, 2026-10-03 (slice 0 item 4, Hossein): rules 1 to 8 are in
`apps/api/.dependency-cruiser.cjs` and `eslint.config.mjs` under the names above (rule 7 is
`kernel-imports-only-itself`); every ESLint message starts with its rule name, and every ESLint
block reads `.ts`, `.mts` and `.cts`. Added by the reviews of item 4:
`kernel-only-through-package-entries` (dependency-cruiser, Bagher: outside the kernel, code
reaches it only by its two package names, never by a path into its `src/` or `dist/`;
`scripts/check-built-kernel.mjs` proves that the `exports` map refuses deep imports at run
time); `market-context-only-through-the-decorator` (dependency-cruiser, Hassan M2: a module
imports nothing from `platform/market-context/` or `platform/health/` but
`market.decorator.ts`); rule 5 also as `@typescript-eslint/no-restricted-imports` in modules
(`mintMarketContext` from the kernel, including `import *` and `export *`; `DiscoveryService`,
`DiscoveryModule` and `ModulesContainer` from `@nestjs/core`);
`only-the-guard-attaches-market-context` (ESLint, Hassan: only the guard file uses
`attachMarketContext`); `imports-are-static` (ESLint, Hassan M3: no computed `import()`,
`require`, `createRequire`, `process.mainModule` or `eval` in `apps/api/src`; the kernel has no
`import()` at all, and a module has none either). Rule 4 also forbids `Date()`; rule 3 also
matches `@js-temporal/polyfill`, the A2 fallback; rule 6 allows
`platform/health/health.controller.ts` only. Rule 2 also blocks `src/modules/index.ts`. Rule 4
covers `src/modules/`, `src/platform/` and the kernel; the root bootstrap files and
`src/verticals/` are outside it. `HealthResponse` moved to `platform/health/health-response.ts`.
`apps/api/test/boundaries.spec.ts` also checks that `persistence.module.ts`,
`database-probe.ts`, the guard file and the health controller export only their allowed names,
that `apps/api/src` and the kernel's `src` hold only `.ts` files, that every rule is an error,
and that every dependency-cruiser rule has a fixture that breaks it.

Deferred by the reviews of item 4 (W1 to W6 Hassan, B1 Bagher), each with its trigger:

| # | Item | Trigger |
|---|---|---|
| W1 | A module copying the exemption metadata of `HealthController`: closed by `market-context-only-through-the-decorator`. Add a test that the only exempt controller in `AppModule` is `HealthController` | The first controller outside `platform/` (slice 1) |
| W2 | Move `mintMarketContext` to a kernel entry that only the factory may import; `platform/authz` and the UnitOfWork check "hosted" as well as "minted" | Slice 1, with the actor constructors and `createCallContext` |
| W3 | Split `attachMarketContext` into a file that only the guard may import | Slice 1, when the actor is attached |
| W4 | Wall-clock forms that rule 4 misses in `domain/` and `application/`: `new globalThis.Date()`, `const D = Date`, `Date['now']()`, `Reflect.construct(Date, [])`, `performance.*`, `new Intl.DateTimeFormat().format()`, `const { Now } = Temporal`; through `no-restricted-properties` and `no-restricted-globals` | Slice 1, the first domain code with an expiry |
| W5 | `linterOptions.noInlineConfig` for `src/`, so a disable comment cannot switch a boundary rule off | Slice 1 |
| W6 | The "aliased" exemption of `kernel-only-through-package-entries` trusts `apps/api/tsconfig.json`'s two `paths` entries; review it if `tsconfig.build.json` ever gains `paths` | Any `paths` change in the API's tsconfig files |
| B1 | Extend `no-wall-clock` to `src/verticals/` | Slice 1, or earlier when the first code lands in `src/verticals/` |

## 9. Testing

| What | Kind | Notes |
|---|---|---|
| `Result`; `parseId` (accepts canonical version 7; rejects upper case, other versions, noise); `uuidV7` (a known timestamp and bytes give a known string; version and variant bits; a later millisecond sorts later; bad input throws); `parseMarketId`, `parseTenantId`, `parseCorrelationId`; minting (a literal, a spread copy and a JSON round trip are all refused by `isMinted`; minted values are frozen) | Unit, kernel: no Nest, no database | Kernel specs use literals: they cannot read the fixture files (no Node types). `parseMarketId` is asserted against the loaded fixtures in an api test |
| Instants converted in the ADR-0005 decision 8 zones (Brisbane, Sydney, Adelaide, Perth) and on a daylight-saving change day, through the kernel export | Unit, kernel | Also guards the later move to native Temporal |
| Market resolution: accepted with the header; the three 400 answers of 5.1, with the value absent from body and logs; a repeated header; health and `/docs` without the header; a stack hosting only one fixture refuses the other (residency guard); the `APP_GUARD` list and order; the OpenAPI parameter | HTTP test, both fixtures | `apps/api/test/support/test-config.ts` hosts the launch Market and the synthetic `ZZ`. Slice 0 has no non-platform endpoint, so the tests register a test-only controller that returns the resolved Market; cases run for every entry of `TEST_MARKETS` |
| Correlation id: an inbound `x-correlation-id` is never the id of the request; it appears once as `clientRequestId`; a malformed one is dropped | HTTP test | Replaces today's "propagates a well-formed correlation id" test in `app.e2e.spec.ts` (C3) |
| Slice 1 and 2: a request with a credential and no Market never reaches `Authenticator`; a session of another Market gets the same answer as an unknown token; `createCallContext` refuses an actor of the other Market; a contracts test fails a free-string event payload field | HTTP and unit, both fixtures | The permission registry is market-free and needs no fixture |
| `SubjectKeyService`: a key or ciphertext of one Market fails under the other; a wrapper failure and a bad tag throw and are never `subject-key.destroyed`; the store (create, destroy, tombstone, second `createKey` refused) | Unit with both fixtures; database (`pnpm test:db`) | Slice 1 |
| Database: rows are built from the factory's context (replacing the tenant literal in `apps/api/test/db/platform.db-spec.ts`); a catalog test that every table with `market_id` has `tenant_id`, both NOT NULL with no default; the role-separation tests of item 7 | Database (`pnpm test:db`), run as the application role | Slice 0 item 7 for the roles; the catalog test with item 3 |
| One fixture per new rule of 8.2 | `apps/api/test/boundary-fixtures/`, asserted in `apps/api/test/boundaries.spec.ts` | As today |

Fakes come from `@mondapac/shared-kernel/testing` (8.1), so api and web share them and `src/`
cannot import them (rule 8). `FixedClock(start)`: `now()` returns the same instant until the
test calls `advance(duration)` or `set(instant)`; it never ticks by itself.
`SequenceIdGenerator(clock)`: `uuidV7(clock time, counter)`, so ids are valid version 7,
predictable and rising. One test asserts that the composition root binds the real ones.

## 10. Dependencies and evidence

My checks ran on Node 24.9.0 (then the ADR-0014 minimum) and 24.21.0, in a scratch folder outside
the repository; nothing was installed in the repository.

Note, 2026-10-03: ADR-0021 raises the minimum Node version to 24.15. The runs at 24.9.0 in this
document had `engine-strict` off, because `pnpm install` fails there under it; what depends on the
version is re-run on 24.15 (identity design 12.3).

| Need | Covered by | Evidence |
|---|---|---|
| Temporal | `temporal-polyfill` 1.0.5, pinned exactly (A2), under the approval of ADR-0008 decision 4. Fallback: `@js-temporal/polyfill` | `globalThis.Temporal` is undefined on both Node versions without `--harmony-temporal`. `@js-temporal/polyfill` 0.5.1 (CommonJS entry, one dependency) and `temporal-polyfill` 1.0.5 (ES module only, two dependencies) both load with `require()` on 24.9.0, typecheck with TypeScript 6.0.3 under `tsconfig.base.json`, and leave the global untouched. Under the kernel's `jest` script the first passes as is; the second fails ("Must use import to load ES Module") and passes only with `--experimental-vm-modules`, which the api tests already use (ADR-0014 decisions 2 and 8: test-only). Neither package declares an install script (their dependencies were not checked). Ali: 0.5.1 was last published 2025-03-31 and its README still lists the production release as open; 1.0.5 was published 2026-09-11 |
| UUIDv7 | No package: a pure layout function in the kernel plus random bytes from `node:crypto` | `crypto.randomUUIDv7()` exists on 24.21.0 but **not** on 24.9.0; it takes no timestamp, so it cannot use the injected Clock; 200,000 calls in a loop were not strictly increasing |
| Subject keys | `node:crypto`: authenticated encryption, HMAC, key derivation, key wrapping | On 24.9.0: AES-256-GCM round trip with associated data, `createHmac`, `hkdfSync`, cipher `id-aes256-wrap` listed |
| UnitOfWork binding | `AsyncLocalStorage` from `node:async_hooks` (ADR-0004 decision 5) | Present on 24.9.0 |
| Boundary claims of 8.2 | — | dependency-cruiser with the real configuration on a scratch copy of `apps/api`: `domain/` → kernel, `platform/` → `modules/identity/index.ts` and `identity` → `modules/sellers/index.ts` all pass today (repeated by Hossein) |
| Security headers | `helmet`, approved by the owner (ADR-0015 decision 3) | Hossein: the default policy of `helmet` 8.3.0 allows the `/docs` page |
| Body parser after the logger (item 5, **C5**) | No new declaration: `pino-http` mounted on the adapter with `app.use(...)`, then `app.useBodyParser('json', …)`, with `LoggerModule` given the same `pino` instance and `useExisting: true` | Tested on 24.21.0 in a scratch copy: malformed JSON answers 400 and an over-limit body 413, each with the correlation id header and a request log line; with today's wiring the 400 has neither (Security L4 reproduced). Not tested: logs outside a request under `useExisting` (the library's code builds the root logger from the same parameters). Hossein's tested fix imports `express` instead; `express` 5.2.1 is already installed through `@nestjs/platform-express` |
| **To be verified by a spike** | — | The polyfill in a web bundle (size, Next.js build) |
| Requests for the bundled list at G2 (ADR-0018 decision 8); none needed for slice 0 | — | A KMS client for the deployed `KeyWrapper` adapter, only when a deployed environment exists (Kazem); the rate-limiting package (I11) |
| Side note for G2 (ADR-0018 decision 8) | — | `typeof crypto.argon2` is `function` on 24.9.0; the RFC 9106 vectors were not run here |

Verified by the reviewers, in scratch copies on Node 24.21.0 unless stated; the repository was
not touched:

| Fact | By | Used in |
|---|---|---|
| `APP_GUARD` providers run in module import order, then `useGlobalGuards`, then controller guards; a module imported earlier ran its guard before the market guard | Hossein | 5.1 |
| `/docs`, `/docs-json` and `/docs/swagger-ui-init.js` are served with zero guard calls; an unmatched route answers 404 with no guard call; `Reflector.createDecorator` works as the exemption | Hossein | 5.1 |
| Node joins a repeated header into the one string `AU, ZZ`, never an array (`req.headersDistinct` has the array); the Market pattern rejects it | Hassan, Hossein | 5.1 |
| With the kernel imported, `pnpm typecheck` fails with TS6059 until `rootDir` is `"../.."`; `nest build` fails with TS2307 unless the kernel's `dist/` exists, and `pnpm dev` uses the same configuration; CI is fine because `pnpm -r build` builds the kernel first | Hossein | 7 item 3, 13 |
| A forged literal context (`{ kind: 'system', marketId: … }`) compiles under TypeScript 6.0.3 without importing a constructor | Hassan | 3.7 |
| Node accepts a 4-byte GCM authentication tag unless `authTagLength` is set | Hassan | 4 |
| body-parser 2.3.0 puts the raw body on its error object and pino's serializer copies it; malformed JSON today answers 400 with no correlation id and no log line | Hassan, Hossein | 7 items 5 and 6 |
| An unbound port token fails boot with `UnknownDependenciesException`, as does one provided but not exported; `overrideProvider` on a token nobody provides binds nothing | Hossein | 6.3 |
| Rules 1, 3 and 6 work in dependency-cruiser and rules 4, 5 and 7 in ESLint, with the notes of 8.2; rule 2 was not run against a fixture | Hossein | 8.2 |
| PostgreSQL prints `uuid` in lower case and uuid order equals text order. On PostgreSQL 16 with the baseline migration, the application role's `UPDATE`, `DELETE`, `TRUNCATE`, `DISABLE TRIGGER`, `DROP TRIGGER`, `SET session_replication_role` and `SET ROLE` fail with `42501`, and the owner still gets `23001` | Mojtaba | 3.1, 7 item 7 |

## 11. Trade-offs and what to revisit

| Choice | Cost accepted | Revisit when |
|---|---|---|
| Explicit `CallContext` | One more parameter on every call | Only with evidence that the plumbing causes defects |
| Minted contexts (C2) | A context cannot be rebuilt from JSON or spread; one copy of the kernel per process | A second process or a queue must carry a context: it carries ids and mints again through the factory |
| Header-only Market resolution | Host mapping moves in front of the API, and that tier must overwrite the header | The domain strategy is decided, or a browser calls the API on a Market host |
| Generated correlation id (C3) | No end-to-end id chosen by the caller | A real client needs one; then a separate, erasable field |
| Tenant as a constant (A5) | A second tenant needs a code change | A real SaaS tenant exists (ADR-0001 decision 3) |
| Kernel code one slice before its consumers (`Id`, `Clock` in slice 0) | A small risk of designing blind; low, because ADR text fixes them, and slice 1 stays smaller | A slice 1 consumer needs a different shape |
| `parseId` accepts version 7 only | Other UUID versions are rejected | Another system's ids must be stored as `Id` |
| Test fakes on a `/testing` subpath | One `exports` entry, one `paths` entry and one jest mapping to keep in step | The web app needs a different resolution |
| No cache of unwrapped subject keys | One unwrap per operation | A deployed key service adds a network call; needs measurements and a design reviewed by the security-tester |
| Catalogue is code, sealed at boot; `allOf` only | A permission change needs a deploy (the intent of ADR-0018 decision 4); a use case open to both panels is two use cases | A module's gate shows a real need |
| `temporal-polyfill` (ES module only) | `--experimental-vm-modules` in the kernel's test script; one more dependency in api and web | The Node LTS in use ships Temporal (ADR-0008 decision 4): one file changes |

## 12. Decisions, confirmations and open inputs

**Confirmed by the CTO in the final check, 2026-10-03** (C1 to C6; the wording is applied in
the body):

| # | Point | Where |
|---|---|---|
| C1 | The CI access-rule check lands in slice 1: required by the security-tester, recommended here; G2 names the slice and cannot name a later one without his agreement | 6.4 row 8 |
| C2 | Minted contexts: non-exported brand, frozen values, a private `WeakSet`; `platform/authz` and the UnitOfWork refuse an unminted context; rule 5 also bans `as` assertions. Cost: no context from JSON | 3.7 |
| C3 | The API always generates the correlation id; an inbound value is logged once as `clientRequestId`. This changes the Phase 1 behaviour of `platform/logging/correlation-id.ts`; recorded as ADR-0020 decision 8 | 3.6, 7 item 3, 13 |
| C4 | One checked-in list of non-permission declarations, and a retired-key list; both part of the proposal to G2 | 6.2 row 5, 6.1 row 4 |
| C5 | Items 5 and 6 need no direct `express` dependency: the wiring tested for section 10 uses only packages already declared. Ali: confirmed. If item 5's tests cannot pass on that wiring, `express` is declared in `apps/api` at the range `@nestjs/platform-express` already resolves; pre-approved, since it is already in the lockfile | 10, 7 item 5 |
| C6 | **Wording differs from the first review.** Hassan asked that `own-resources` cover "the actor's own account only". Customers hold no roles (R2), so their later resources (orders, addresses) can only be reached through this kind. In his second check Hassan accepted that, with the wording now in 6.2: resources of a seller or of the platform always need `permissions`, and a customer account's later resources join the kind at that module's gate | 6.2 row 2 |

### (a) Decisions taken by Ali (cto), 2026-10-03
| # | Question | Decision |
|---|---|---|
| A1 | Defer the signatures of the three ADR-0009 value types | Deferred to the G2 of the first consumer. ADR-0020 adds an inline note to ADR-0015 decision 3 row 1. `ContentHash` is decided in the audit-seal design (slice 6) |
| A2 | The Temporal polyfill package | `temporal-polyfill` 1.0.5, pinned exactly. Evidence is required in the dependency PR (item 1); if a check fails, fall back to `@js-temporal/polyfill` without a new approval. ADR-0020 records the package |
| A3 | `CallContext` and `CorrelationId` as kernel types | Yes, both. ADR-0020 adds an inline note to ADR-0008 decision 1, which also gains `ActorContext` |
| A4 | Market resolution | Header only, `x-market-id`. ADR-0020 decision 3 amends ADR-0003 decision 2 |
| A5 | Source of the tenant id | A constant, not configuration: one named constant in `platform/market-context/`, provided through a token. No amendment: it matches ADR-0004 decision 4. ADR-0020 decision 6 records the reading |
| A6 | Kernel types in slice 0 or slice 1 | Slice 0: `Id`, `Clock`, `MarketContext`, `Result`, `CorrelationId`. Slice 1: `DomainEvent` (with the outbox), `ActorContext`, `CallContext` |
| A7 | The rule list of 8.2 | Approved with the rule 4 wording of 8.2; rule 2 moves to slice 0 |
| A8 | `MarketConfig.status` at request level | "Hosted" is the only gate in Phase 2; `status` has no run-time effect. ADR-0020 adds a trigger row: the semantics are decided before the first publicly reachable deployment and enforced in `MarketContextFactory` |
| A9 | R7 and the later `legal` facade | The empty allow-list is approved, in slice 0. ADR-0020 records that R7 (through ADR-0018 decision 4) and ADR-0009 decision 4 conflict on paper; a note on ADR-0009 decision 4 defers the resolution to the `legal` gate |

### (b) Inputs to identity G2
| # | Input |
|---|---|
| I1 | `ActorContext` fields (3.4). A pending second factor is never an authenticated actor |
| I2 | The access-rule mechanism, its CI check and its slice, within 6.4 |
| I3 | The `Authenticator` credential; denial to HTTP status; reason codes. The CSRF check sits in the platform guard path; `x-market-id` is not the CSRF defence; the session cookie is a `__Host-` cookie, distinct per Market |
| I4 | UnitOfWork, outbox, relay, event bus, scheduler, `APP_ROLE`: who stamps the envelope (3.6); worker entry adapters (5.1); the UnitOfWork is opened with a `MarketContext`; recommended: an error result commits nothing |
| I5 | The `market_id` guard: presence as a top-level equality only (ADR-0004 decision 3), or also equality with the Market the UnitOfWork was opened for. The security-tester requires equality (the factory can mint any hosted Market, rule 5 of 8.2) and Mojtaba recommends it. It must also cover `create` data and raw queries, and `PrismaService extends PrismaClient` has to change shape for `$extends` |
| I6 | **Prerequisite for the first identity table.** `SubjectKeyService` gives no equality search, so email uniqueness (ADR-0018 decision 3) needs a G2 choice: a plaintext live column, or a lookup hash under a stack-level key that this port does not provide. A lookup value lives only in a deletable live column under its own key. Also: what a subject is (an invitation holds an email before an account exists), the wrapped-key size and wrapping-key identifier, the rotation procedure, tombstone retention, and the other open points of section 4 |
| I7 | `aggregate_version` as in 3.6: 32 bits, starts at 1, the optimistic-lock column |
| I8 | An audited action by an anonymous actor, such as a failed admin sign-in (brief section 9), has no row shape (`docs/design/data/platform.md` 3.2 and 3.6): no target for an unknown email, no transaction to join, and attacker-driven volume in a table that is never pruned. Mojtaba wants sign-in records in an identity-owned table with retention; otherwise `ANONYMOUS` joins the CHECK while the table is still empty |
| I9 | Catalogue content; whether the action segment is a closed vocabulary; validation of the default-role seed against the registry; the slice of the registry. Per-Market seeds cannot be migrations |
| I10 | Operator routines (first admin) name their Market and use the factory of 5.1 |
| I11 | The rate-limiting store and package. The trust-proxy value is set before any origin-keyed throttle; counters are not split by Market |
| I12 | The API error format; this design fixes only the three answers of 5.1 |
| I13 | R7 and rule 2 mean that sign-in cannot call `sellers`. This constrains the split of access state and membership left open by ADR-0018 decision 9 |
| I14 | The "model to owning module" rule: a map generated from the schema files, with a named exception for `<module>.outbox` and `inbox`, which the relay reads |
| I15 | Tokens never go in the URL path, because the logger keeps the path. Worth checking, not traced: database driver errors may carry values (`Key (email)=(…)`), so log the name, the code and the stack only |

### (c) For the owner
None; no reviewer has an owner question, and this design asks for no dependency beyond the
approved polyfill and `helmet` and, only if C5's fallback is used, a direct declaration of
`express` (already installed transitively). Three things reach the owner later through existing
routes: the bundled dependency list at G2; the launch playbook's domain strategy, which A4 does
not need; and Market status semantics before the first public deployment (A8). ADR-0020 is
accepted by the CTO and the owner is informed in the Phase 2 status summary.

### (d) Answers to the backend developer's questions
| Question | Answer |
|---|---|
| The 400 body and codes of 5.1 | `{ statusCode, code }` with `market.header-missing`, `market.header-invalid`, `market.not-hosted`; the value is never echoed or logged (5.1) |
| The `TenantId` pattern | `^[a-z][a-z0-9-]{1,31}$` (3.3) |
| Kernel constructor names; throw or `Result` | The table of 3.7: parse functions return a `Result`; `uuidV7` and `createCallContext` throw |
| `x-market-id` in OpenAPI without marking `/health` | Added per operation after the document is built, skipping exempt controllers; no global parameter (5.1) |
| Who attaches the anonymous actor in slice 1 | A guard, second in the `APP_GUARD` array; `@Market()` and the context decorator throw when nothing is attached (5.1, 5.2) |
| Are the clock, id and market-context modules `@Global()` | Yes (5.1). The authorisation ports are not: `IdentityModule` exports them (6.3) |
| Positive kernel fixture; kernel specs and the fixture files; repeated header | 7 item 4; section 9; 5.1 |

## 13. Follow-up changes

This document changes no other file. After approval these change, each by its owner, in a PR of
its own where `docs/process/parallel-tracks.md` calls the file shared:

| File | Change | When |
|---|---|---|
| This document | `ActorContext` fields written back; section 6 confirmed or changed | After identity G2 |
| ADR-0020 (new; drafted by Ali on this branch, not by this design) | A1, A3, the A4 amendment, the A8 trigger row, the A9 record, the tenant reading (decision 6), the polyfill package, the generated correlation id (decision 8); inline notes on ADR-0003 decision 2, ADR-0008 decision 1, ADR-0009 decision 4 and ADR-0015 decision 3; one clause in the ADR list of `CLAUDE.md`; one row in the change log of `docs/modules/identity/brief.md` | With the approval (same PR) |
| `packages/shared-kernel/package.json`, `apps/api/package.json`, `pnpm-lock.yaml` (shared) | `temporal-polyfill` 1.0.5 exact and the `test` script flag; `helmet`; `express` only if C5 goes the other way; the `exports` map with `./testing` (item 2) | Slice 0 items 1, 2 |
| `packages/shared-kernel/src/index.ts` | Exports; header comment updated to the new type list | Slice 0 item 2 |
| `apps/api/tsconfig.json` (shared), `apps/api/jest.config.cjs`, `apps/api/jest.db.config.cjs` | `rootDir: "../.."`; the `/testing` path and mapping | Slice 0 items 2, 3 |
| Root `package.json` `dev` script and the Commands text of `CLAUDE.md` (both shared) | `dev` builds the kernel first. No other change to `CLAUDE.md` beyond the ADR-0020 clause: "every use case takes an ActorContext and a MarketContext" stays true with `CallContext` | Slice 0 item 3 |
| `apps/api/src/app.module.ts`, `platform/health/health.controller.ts`, `platform/market-config/market-registry.ts`, `openapi.ts`, `apps/api/test/app.e2e.spec.ts` | The guard array; the exemption; minting through the factory; the header parameter; the new and changed tests | Slice 0 item 3 |
| `platform/config/app-config.ts`, `platform/market-config/market-config.ts` | Use the kernel's `parseMarketId`. No tenant field (A5) | Slice 0 item 3 |
| `platform/logging/correlation-id.ts` and its spec, `platform/logging/logging.module.ts` | Generated id, `clientRequestId` (C3); the kernel's `CorrelationId`; `useExisting` (C5), unless item 5's tests force the `express` fallback | Slice 0 items 3, 5 |
| `apps/api/src/main.ts`, `apps/api/src/configure-app.ts`, the test bootstraps | `bodyParser: false` in the shared setup; logger, `helmet`, parser and limits in one order | Slice 0 items 5, 6 |
| `eslint.config.mjs` (shared) | Rules 4, 5, 7 of 8.2 | Slice 0 item 4 |
| `apps/api/.dependency-cruiser.cjs`, `apps/api/test/boundaries.spec.ts`, `apps/api/test/boundary-fixtures/` (with its `tsconfig.json`) | Rules 1, 2, 3, 6, 8; rule 9 with the access-rule mechanism | Slice 0 item 4; G2 slice |
| `.github/workflows/ci.yml`, `.env.example` (both shared) | The header assertion in the boot probe; the migration and application database URLs. No tenant variable (A5) | Slice 0 items 6, 7 |
| `prisma.config.ts` (shared), `scripts/check-migrations-reversible.mjs` and the other `scripts/*.mjs`, `apps/api/test/db/*`, `docker-compose.yml` (shared), `platform/config/app-config.ts`, a grants migration with `down.sql` | Two roles and two URLs; tests run as the application role; the tenant literal in `platform.db-spec.ts` replaced by the factory's context | Slice 0 item 7 |
| `docs/design/data/platform.md` | Mojtaba: a new section closing Q3 (the grant half of the role note); "REVOKE" in 3.4 becomes "grant only" | Before item 7's PR |
| Board, frontend track | The D2 ADR states what sends `x-market-id`: by default the panel's server tier, which overwrites any client-supplied header | Already on the board |
| Board, product track (sellers brief) | Sign-in cannot call `sellers` (R7, rule 2, ADR-0018 decision 3; I13) | Already on the board |

Note, 2026-10-03 (Ali): item 3 also ends the root `build` script with `scripts/check-built-kernel.mjs`, which proves on the built API that both kernel entries load one `dist/` and that a `/testing` context passes `isMinted` there; item 4 adds the deep-import assertions. `market-registry.ts` mints nothing; `MarketContextFactory` is the only minter. The tenant literal in `platform.db-spec.ts` is replaced by whichever of items 3 and 7 merges second.
