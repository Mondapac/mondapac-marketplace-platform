# ADR-0054: High-Traffic Per-Origin Rate-Limit Counters in Redis

**Status:** Accepted — 2026-11-26 (owner decision Q1 of the A2 design "rate-limit counters without
a single-row lock", version 2: Redis with the new package `ioredis`; build of R1 approved with
«ساخت» after A1, PR #1405, merged). Design reviewed by Mohammad (software-architect), Hassan
(security-tester), Mojtaba (database-designer) and Kazem (devops-engineer), all "accept with
changes", applied in version 2.
**Amends:** identity design 6.8 (row "Generic, per origin") and 13 (row "Generic rate limiting per
origin": "no Redis client"; 12.2 row "Redis client"); `docs/design/data/platform.md` section 12
(rows Writes, Physical, Limit classes, Failure, Tests); the failure rule of identity design 5.2
for three limit classes only (decision 3)
**Relates to:** ADR-0004 decision 1 (Redis is in the stack for rate limiting), ADR-0003 (Redis is
part of every Region Stack), ADR-0018 decisions 2 and 8, ADR-0031, ADR-0015 decision 3

## Context
`RateLimitGuard` counts every market-scoped request with one `INSERT ... ON CONFLICT (key) DO
UPDATE ... RETURNING` on `platform.rate_limit_counters`. Each origin and class has one row, so all
concurrent requests of one origin queue behind that row's lock, held until commit (WAL flush).
On a slow machine the wait passes `lock_timeout = 3s` of `mondapac_api`, the statement is
cancelled and the guard fails closed with 503 `access.unavailable` (storefront-live-gaps report,
section 8; A1 logged the cause, 55P03). On a healthy database this takes milliseconds, but any
database slowness becomes a 503 for every request of the site, a shared NAT puts hundreds of
buyers on one hot row, and every read adds a WAL write and a dead tuple. Sharded rows, an
`UNLOGGED` table or `synchronous_commit=off` shorten the hold but keep the queue; memory only
(before PR #428) breaks the shared count a second instance needs.

## Decision
1. **Two stores, one port.** `RateLimitCounters` and the guard do not change. `RoutedRateLimitCounters`
   (`platform/rate-limit/`) sends each class to its store by a complete typed map,
   `RATE_LIMIT_STORE_OF: Record<CountedClass, 'redis' | 'postgres'>`, so a new class does not
   compile until it names its store.
   - **Redis:** `default`, `public-search`, `public-media` (60-second windows, high traffic), on
     the Redis store of the same package, `rate-limiter-flexible` 11.2.1 (`RateLimiterRedis`: one
     atomic Lua script, `SET NX EX`, `INCRBY`, `PTTL`).
   - **PostgreSQL, fail closed, unchanged:** `anonymous-identity` (sign-in, sign-up, resets, mail;
     Hassan) and every per-subject class (`checkout-payment`, `assistant-message`,
     `admin-customer-password-reset`, `admin-customer-pii-reveal`). They are low-traffic and must
     not restart with Redis. `assistant-message` is also keyed per origin and guest token, so it
     can still queue behind a NAT; at its rate that queue is accepted.
2. **Keys and data.** The Redis key is `rl:<class>:<64 hex>`, the same keyed HMAC as today, never
   an address; it expires with its window, so nothing is purged. Redis holds these counts and
   nothing else: no session, no access decision (ADR-0018 decision 2). The client is in
   `platform/rate-limit/rate-limit-redis.ts`, a provider of its own (`RateLimitStoreModule`), not
   in `PersistenceModule`, which is Prisma only; it is the only file that may import `ioredis`
   (`pnpm boundaries`). It connects lazily, on the first count, so the worker never connects.
3. **When Redis cannot count.** Client: `commandTimeout` 200 ms, no offline queue, no per-request
   retries, the package's `rejectIfRedisNotReady`, a reconnect on `READONLY` (failover). While
   Redis is its store, a failed count of a Redis class is counted in the instance's memory
   (`RateLimiterMemory`), not refused (under the rollback switch it is counted in PostgreSQL and
   fails closed, as before):
   **for these three classes the failure rule changes from "fail closed, 503" to "continue on each
   instance's memory"**, so during an outage the real limit can rise to "limit x instances". A
   circuit breaker sends every request to memory for 5 seconds after 3 failures in a row; when the
   5 seconds end, requests try Redis again (the requests that arrive together all try, there is no
   single probe request) and the first failure sends every request to memory for another 5
   seconds, so a slow Redis adds no 200 ms to every request and counts do not alternate between
   the stores. A Redis restart, failover or eviction can also restart a window
   early. This is accepted for these three classes only. The package's `insuranceLimiter` is not
   used (it hides the failure from the breaker; the behaviour is the same), nor
   `inMemoryBlockOnConsumed` (the counters never refuse: `points` is the safe-integer ceiling and
   the guard compares with the Market's limit, so it would never fire).
4. **Signals.** `rate-limit.store-degraded` (warn) and `rate-limit.store-recovered` (info), on a
   change of state only and at most one line per 30 seconds: the class and a fixed error code,
   never the key, the hash, the host or the client's error text (it can hold a command's
   arguments). The recovered line carries the number of requests counted in memory (the metric
   until R3 adds a CloudWatch metric filter on the degraded line). `rate-limit.store` at start-up
   says which store this process uses.
5. **Configuration.** `REDIS_URL` (`redis://` or `rediss://` host, port, database; no user,
   password or query string, so no URL can switch certificate checks off), `REDIS_USERNAME` and
   `REDIS_PASSWORD` (the ACL user, from the secrets store, K1). In production the URL is
   required, must be `rediss://` (TLS with Node's certificate and host-name checks, as ADR-0031),
   and the user and password are required; otherwise the API does not start. Unset in development
   or test, every class is counted in PostgreSQL as before. `RATE_LIMIT_STORE=postgres` is the
   rollback switch: every class in PostgreSQL again, without a code revert.
6. **ACL.** The rate-limit user may run only `~rl:*` with `EVALSHA EVAL SET INCRBY PTTL EXPIRE GET
   DEL MULTI EXEC PING INFO` (no `SCRIPT`, `KEYS`, `FLUSH*`, `CONFIG`, `CLIENT`); ACL is checked on
   each command inside the Lua script too, so a CI test runs the counters as that user. The client
   therefore sends no `CLIENT SETNAME` or `SETINFO`.
7. **Phases.** R1 (this ADR, code, CI Redis); R2, documentation only (amended 2026-11-26, see
   below); R3 with the
   first deployment (Phase 7): ElastiCache Valkey 8, `volatile-ttl` in a custom parameter group,
   no snapshots, the ACL user, alarms and the runbook (Kazem, Hassan), after the K1 rate-limit
   secret exists.

## Consequences
- No row lock on the hot path of the storefront: a slow database no longer turns into a 503 for
  every page; the sensitive classes keep their exact, durable, fail-closed counts.
- A new deployed service (Redis per Region Stack, ADR-0003) and a new package, `ioredis` 5.11.1,
  exact pin, owner-approved on 2026-11-26 (ADR-0018 decision 8).
- During a Redis outage the three classes are weaker (per-instance counts); the degraded line
  must page (R3). Until R3, readiness does not depend on Redis.
- Every new class, in either store, still widens the key CHECK: the rollback switch and a run
  without Redis count the Redis classes in PostgreSQL (amendment below).
- CI runs a Redis service (Valkey 8) in every job that boots the API; tests count in memory unless
  they ask for Redis (`createTestApp({ rateLimitStore: 'redis' })`, a key prefix per worker).

## Amendment 2026-11-26 (R2)
R2 was planned as a contract migration that deletes the rows of the Redis classes and narrows
`rate_limit_counters_key_check` to the PostgreSQL classes. Building it showed that the narrower
CHECK breaks decision 5: with `RATE_LIMIT_STORE=postgres`, or in development or test without
`REDIS_URL`, `RoutedRateLimitCounters` counts `default`, `public-search` and `public-media` in
PostgreSQL, and those writes would fail the CHECK and every route would fail closed with 503.
The owner chose to keep the CHECK as it is, listing every counted class, so the rollback switch
keeps working. No migration: rows of the Redis classes written before R1, or during a rollback,
are deleted by the usual purge of windows that ended over an hour ago. R2 is this amendment, the
aligned wording of decision 3 and the review notes in the future-enhancements register.
