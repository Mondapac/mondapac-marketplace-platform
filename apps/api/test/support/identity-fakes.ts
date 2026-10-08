import type { TestingModuleBuilder } from '@nestjs/testing';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, PendingEvent, Population, Result } from '@mondapac/shared-kernel';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepository,
} from '../../src/modules/identity/application/ports/account.repository';
import {
  PASSWORD_HASHER,
  type PasswordHasher,
  type PasswordHasherBusy,
  type PasswordVerification,
} from '../../src/modules/identity/application/ports/password-hasher';
import {
  SESSION_REPOSITORY,
  type SessionForAuthentication,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import {
  SIGN_IN_RECORD_REPOSITORY,
  type SignInRecord,
  type SignInRecordRepository,
} from '../../src/modules/identity/application/ports/sign-in-record.repository';
import {
  THROTTLE_REPOSITORY,
  type ThrottleCounter,
  type ThrottleRepository,
} from '../../src/modules/identity/application/ports/throttle.repository';
import { Account, type AccountState } from '../../src/modules/identity/domain/account';
import type { Session } from '../../src/modules/identity/domain/session';
import {
  windowRestartBefore,
  type ThrottleReservation,
} from '../../src/modules/identity/domain/throttle';
import { OUTBOX_WRITER, type OutboxWriter } from '../../src/platform/events/outbox-writer';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';

// In-memory fakes of identity's database ports, for the HTTP suites of `pnpm test` (no
// database). Units are not isolated: `run` calls `work` once. The fakes keep the rules the
// suites depend on (unique keys, the throttle windows of data design 3.5); the PostgreSQL
// behaviour itself is covered by test/db/.

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** A fake PHC string: `fake$<password>`; verify compares the password. */
export const fakeHashOf = (password: string): string => `$argon2id$v=19$fake$${password}`;

export class IdentityFakes {
  readonly accounts = new Map<string, AccountState>();
  readonly sessions = new Map<string, { session: Session; tokenHash: string }>();
  readonly throttles = new Map<string, ThrottleReservation & { accountKey: string | null }>();
  readonly records: (SignInRecord & { marketId: string })[] = [];
  readonly events: PendingEvent[] = [];
  hashed = 0;
  verified = 0;
  busy = false;
  /** Makes the reservation unit fail, as an unreachable counter table would. */
  throttlesDown = false;

  reset(): void {
    this.accounts.clear();
    this.sessions.clear();
    this.throttles.clear();
    this.records.length = 0;
    this.events.length = 0;
    this.hashed = 0;
    this.verified = 0;
    this.busy = false;
    this.throttlesDown = false;
  }

  /** Stores an account directly, as a test fixture. */
  seedAccount(state: AccountState): void {
    this.accounts.set(state.id, state);
  }

  readonly unitOfWork: UnitOfWork = {
    run: <T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  };

  readonly accountRepository: AccountRepository = {
    findByEmail: (market: MarketContext, population: Population, email: string) => {
      const state = [...this.accounts.values()].find(
        (a) =>
          a.marketId === market.marketId &&
          a.population === population &&
          a.email.normalized === email,
      );
      return Promise.resolve(state === undefined ? null : Account.restore(state));
    },
    findById: (market: MarketContext, id: Id<'Account'>) => {
      const state = this.accounts.get(id);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId ? null : Account.restore(state),
      );
    },
    add: (_market: MarketContext, account: Account) => {
      this.accounts.set(account.state.id, account.state);
      return Promise.resolve(ok(undefined));
    },
    save: (_market: MarketContext, account: Account) => {
      this.accounts.set(account.state.id, account.state);
      return Promise.resolve();
    },
  };

  readonly sessionRepository: SessionRepository = {
    add: (_market: MarketContext, session: Session, tokenHash: Uint8Array) => {
      this.sessions.set(session.id, { session, tokenHash: hex(tokenHash) });
      return Promise.resolve();
    },
    findForAuthentication: (market: MarketContext, tokenHash: Uint8Array) => {
      const found = [...this.sessions.values()].find(
        (s) => s.session.marketId === market.marketId && s.tokenHash === hex(tokenHash),
      );
      if (found === undefined) return Promise.resolve(null);
      const account = this.accounts.get(found.session.accountId)!;
      const answer: SessionForAuthentication = {
        session: found.session,
        accountStatus: account.status,
      };
      return Promise.resolve(answer);
    },
    findById: (market: MarketContext, id: Id<'Session'>) => {
      const found = this.sessions.get(id);
      return Promise.resolve(
        found === undefined || found.session.marketId !== market.marketId ? null : found.session,
      );
    },
    touch: (_market, id, now, lastSeenBefore) => {
      const found = this.sessions.get(id);
      if (
        found !== undefined &&
        found.session.revokedAt === null &&
        Temporal.Instant.compare(found.session.lastSeenAt, lastSeenBefore) <= 0
      ) {
        found.session = { ...found.session, lastSeenAt: now };
      }
      return Promise.resolve();
    },
    revoke: (market, id, accountId, reason, now) => {
      const found = this.sessions.get(id);
      if (
        found === undefined ||
        found.session.marketId !== market.marketId ||
        found.session.accountId !== accountId ||
        found.session.revokedAt !== null
      ) {
        return Promise.resolve(false);
      }
      found.session = { ...found.session, revokedAt: now, revokedReason: reason };
      return Promise.resolve(true);
    },
    purgeExpired: () => Promise.resolve(0),
  };

  readonly throttleRepository: ThrottleRepository = {
    reserve: (market: MarketContext, counters: readonly ThrottleCounter[], now) => {
      if (this.throttlesDown) return Promise.reject(new Error('counter table unreachable'));
      return Promise.resolve(
        counters.map((counter) => {
          const key = `${market.marketId}|${counter.kind}|${hex(counter.keyHash)}`;
          const existing = this.throttles.get(key);
          const created: ThrottleReservation & { accountKey: string | null } = {
            kind: counter.kind,
            keyHash: counter.keyHash,
            accountKey: counter.accountKey === null ? null : hex(counter.accountKey),
            attempts: 0,
            windowStartedAt: now,
            blockedUntil: null,
          };
          let row = existing ?? created;
          if (
            existing !== undefined &&
            Temporal.Instant.compare(row.windowStartedAt, windowRestartBefore(counter.rule, now)) <=
              0
          ) {
            row = { ...row, attempts: 0, windowStartedAt: now };
          }
          row = { ...row, attempts: row.attempts + 1 };
          this.throttles.set(key, row);
          const reservation: ThrottleReservation = {
            kind: row.kind,
            keyHash: row.keyHash,
            attempts: row.attempts,
            windowStartedAt: row.windowStartedAt,
            blockedUntil: row.blockedUntil,
          };
          return reservation;
        }),
      );
    },
    release: (market, reservations) => {
      for (const r of reservations) {
        const key = `${market.marketId}|${r.kind}|${hex(r.keyHash)}`;
        const row = this.throttles.get(key);
        if (
          row !== undefined &&
          row.attempts > 0 &&
          row.windowStartedAt.equals(r.windowStartedAt)
        ) {
          this.throttles.set(key, { ...row, attempts: row.attempts - 1 });
        }
      }
      return Promise.resolve();
    },
    block: (market, blocks) => {
      for (const { reservation: r, until } of blocks) {
        const key = `${market.marketId}|${r.kind}|${hex(r.keyHash)}`;
        const row = this.throttles.get(key);
        if (row !== undefined && row.windowStartedAt.equals(r.windowStartedAt)) {
          this.throttles.set(key, { ...row, blockedUntil: until });
        }
      }
      return Promise.resolve();
    },
    purge: () => Promise.resolve(0),
  };

  readonly recordRepository: SignInRecordRepository = {
    add: (market, record) => {
      this.records.push({ ...record, marketId: market.marketId });
      return Promise.resolve();
    },
    oldest: () => Promise.resolve(null),
    deleteBetween: () => Promise.resolve(0),
  };

  readonly outbox: OutboxWriter = {
    append: (_context, events) => {
      this.events.push(...events);
      return Promise.resolve();
    },
  };

  readonly hasher: PasswordHasher = {
    hash: (plain: string): Promise<Result<string, PasswordHasherBusy>> => {
      if (this.busy) return Promise.resolve(err({ code: 'request.busy', retryAfterSeconds: 1 }));
      this.hashed += 1;
      return Promise.resolve(ok(fakeHashOf(plain)));
    },
    verify: (
      plain: string,
      stored: string | null,
    ): Promise<Result<PasswordVerification, PasswordHasherBusy>> => {
      if (this.busy) return Promise.resolve(err({ code: 'request.busy', retryAfterSeconds: 1 }));
      this.verified += 1;
      return Promise.resolve(
        ok({ matches: stored !== null && stored === fakeHashOf(plain), needsRehash: false }),
      );
    },
  };

  /** Replaces every database port of identity, and the hasher, with these fakes. */
  override(builder: TestingModuleBuilder): TestingModuleBuilder {
    return builder
      .overrideProvider(UNIT_OF_WORK)
      .useValue(this.unitOfWork)
      .overrideProvider(ACCOUNT_REPOSITORY)
      .useValue(this.accountRepository)
      .overrideProvider(SESSION_REPOSITORY)
      .useValue(this.sessionRepository)
      .overrideProvider(THROTTLE_REPOSITORY)
      .useValue(this.throttleRepository)
      .overrideProvider(SIGN_IN_RECORD_REPOSITORY)
      .useValue(this.recordRepository)
      .overrideProvider(OUTBOX_WRITER)
      .useValue(this.outbox)
      .overrideProvider(PASSWORD_HASHER)
      .useValue(this.hasher);
  }
}
