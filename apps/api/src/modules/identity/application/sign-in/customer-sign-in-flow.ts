import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Account } from '../../domain/account';
import type { EmailAddress } from '../../domain/email-address';
import type { OneTimeLink } from '../../domain/one-time-link';
import { openSession, type Session } from '../../domain/session';
import {
  blockAfterFailure,
  reservationVerdict,
  type ThrottleReservation,
  type ThrottleRule,
} from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { SessionRepository } from '../ports/session.repository';
import type { SessionTokens, ThrottleKeys } from '../ports/session-secrets';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';

/** Where the request came from, read from the socket by the controller (never a forwarded header). */
export interface SignInClient {
  /** The IPv4 address or the IPv6 /64: the key of the origin counters (HF3). */
  readonly origin: string;
  /** The full address, stored in the sign-in record (10.2). */
  readonly address: string;
}

/**
 * Who the attempt is for (identity design 6.3): the typed email, or, to confirm an email (3.2,
 * 6.7), the hash of the link's token in its place.
 */
export type SignInIdentifier =
  | { readonly kind: 'email'; readonly email: EmailAddress }
  /** `tokenHash` null: the presented token does not have a token's shape; it still counts. */
  | { readonly kind: 'link'; readonly tokenHash: Uint8Array | null };

/** A new session. The token goes into the cookie only, never a body or a log. */
export interface SignedIn {
  readonly code: 'signed-in';
  readonly token: string;
  readonly absoluteLifetimeSeconds: number;
}

export type SignInRefusal =
  | { readonly code: 'credentials.invalid' }
  | { readonly code: 'email-verification-required' }
  | { readonly code: 'account.disabled' }
  | { readonly code: 'link.rejected' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

export interface CustomerSignInDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly throttles: ThrottleRepository;
  readonly records: SignInRecordRepository;
  readonly hasher: PasswordHasher;
  readonly tokens: SessionTokens;
  readonly keys: ThrottleKeys;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** What the link variant needs on top: the links, and the outbox for the verification event. */
export interface LinkSignInDependencies {
  readonly links: OneTimeLinkRepository;
  readonly outbox: OutboxWriter;
}

type Reserved = { readonly reservation: ThrottleReservation; readonly rule: ThrottleRule };

type Refused =
  'credentials.invalid' | 'email-verification-required' | 'account.disabled' | 'link.rejected';

/** What the closing unit decided. */
type Closed =
  | { readonly kind: 'signed-in'; readonly session: Session }
  | { readonly kind: 'refused'; readonly code: Refused };

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * The customer sign-in sequence of identity design 6.3 (CUS-02; slices 2 and 3), shared by the
 * two use cases that run it: `SignInCustomer` with the typed email, and `ConfirmCustomerEmail`
 * with the link's token in its place (3.2, 6.7 option B; 8.6 row 3). Not a use case itself:
 * each use case declares its own access rule and calls {@link run} from its `handle`.
 *
 * 1. The generic per-origin limit ran before any identity code (the platform's rate limiter).
 * 2. **Reservation unit** (HF1): one short read-write unit counts the attempt and reads the
 *    account. With an email: the three sign-in counters, then the account by Market,
 *    population and normalised email. With a link: the link by its token hash, its account by
 *    id, then the same three counters, keyed by that account's email; a link that is unknown,
 *    of another purpose, Market or population, used or expired counts on `sign-in.origin`
 *    only and answers `link.rejected` without hashing (one answer for every cause). A counter
 *    at its threshold refuses the attempt without hashing. Counters unreachable: fail closed.
 * 3. **The password is verified outside any unit**, against a dummy hash when there is no
 *    account, so both paths cost one hash (HF12).
 * 4. **Closing unit** (HF11): re-reads the account. A wrong password, an unknown address or a
 *    credential that changed since it was verified is `credentials.invalid`; the failure stays
 *    counted and a counter that reached its limit is blocked. A correct password releases the
 *    reservation. With a link: a disabled account is `account.disabled` and the link stays
 *    unused; otherwise the link is consumed by its conditional statement (a concurrent use,
 *    a new request or the expiry since step 2 answers `link.rejected`), the email is verified
 *    (`identity.account-email-verified.v1`) and sign-in continues. With an email: an
 *    unverified email is `email-verification-required` (Hassan I5) and a disabled account
 *    `account.disabled`. Then a hash with older parameters is replaced and a session with a
 *    new token is created. Every attempt writes one sign-in record (never the email).
 *
 * Refusals are `ok` outcomes of their units, so the counters, the record and the block commit
 * (PN1).
 */
export class CustomerSignInFlow {
  readonly #logger = new Logger('CustomerSignIn');

  constructor(
    private readonly deps: CustomerSignInDependencies,
    private readonly linkDeps: LinkSignInDependencies | null = null,
  ) {}

  async run(
    context: CallContext,
    identifier: SignInIdentifier,
    password: string,
    client: SignInClient,
  ): Promise<Result<SignedIn, SignInRefusal>> {
    const { market } = context;
    const { policy, keys, unitOfWork, throttles, accounts, hasher } = this.deps;
    if (identifier.kind === 'link' && this.linkDeps === null) {
      throw new Error('CustomerSignInFlow: the link variant needs the link dependencies');
    }
    const lifetime = policy.sessionLifetime(market, 'customer');
    if (lifetime === null) return err(UNAVAILABLE);
    const rules = policy.signInThrottles(market);
    const originCounter: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: keys.origin(market, client.origin),
      accountKey: null,
      rule: rules.origin,
    };
    const countersFor = (emailNormalized: string): readonly ThrottleCounter[] => {
      const accountKey = keys.account(market, 'customer', emailNormalized);
      return [
        {
          kind: 'sign-in.account-origin',
          keyHash: keys.accountOrigin(market, 'customer', emailNormalized, client.origin),
          accountKey,
          rule: rules.accountOrigin,
        },
        { kind: 'sign-in.account', keyHash: accountKey, accountKey, rule: rules.account },
        originCounter,
      ];
    };

    // Step 2: the reservation unit (HF1).
    let reservation: {
      readonly reserved: readonly Reserved[];
      readonly account: Account | null;
      readonly link: OneTimeLink | null;
      readonly refusal:
        | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
        | { readonly code: 'link.rejected' }
        | null;
    };
    try {
      const run = await unitOfWork.run(market, async () => {
        const now = this.deps.clock.now();
        let account: Account | null;
        let link: OneTimeLink | null = null;
        let counters: readonly ThrottleCounter[];
        let reservations: readonly ThrottleReservation[];
        if (identifier.kind === 'email') {
          counters = countersFor(identifier.email.normalized);
          reservations = await throttles.reserve(market, counters, now);
          account = await accounts.findByEmail(market, 'customer', identifier.email.normalized);
        } else {
          link =
            identifier.tokenHash === null
              ? null
              : await this.linkDeps!.links.findByTokenHash(market, identifier.tokenHash);
          account =
            link !== null && link.usableFor('verify-email', now)
              ? await accounts.findById(market, link.state.accountId)
              : null;
          if (account !== null && account.state.population !== 'customer') account = null;
          counters =
            account === null ? [originCounter] : countersFor(account.state.email.normalized);
          reservations = await throttles.reserve(market, counters, now);
        }
        const reserved = reservations.map((r, index) => ({
          reservation: r,
          rule: counters[index]!.rule,
        }));
        const verdict = reservationVerdict(reserved, now);
        const refusal = !verdict.allowed
          ? { code: 'request.throttled' as const, retryAfterSeconds: verdict.retryAfterSeconds }
          : identifier.kind === 'link' && account === null
            ? { code: 'link.rejected' as const }
            : null;
        if (refusal !== null) {
          await this.record(context, client, account?.state.id ?? null, refusal.code, null, now);
        }
        return ok({ reserved, account, link, refusal });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reservation = run.value;
    } catch {
      // Fail closed: the counters could not be evaluated, so nothing is hashed (6.8).
      this.#logger.warn({
        msg: 'identity.sign-in.throttle-unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err(UNAVAILABLE);
    }
    if (reservation.refusal !== null) return err(reservation.refusal);
    const { reserved, account, link } = reservation;

    // Step 3: the hash check, outside any unit (HF12).
    const verified = await hasher.verify(
      password,
      account === null ? null : account.state.credential.passwordHash,
    );
    if (!verified.ok) {
      // Nothing was verified: the reservation is given back.
      const released = await this.#failClosed(context, 'release', () =>
        unitOfWork.run(market, async () => {
          await throttles.release(
            market,
            reserved.map((r) => r.reservation),
          );
          await this.record(
            context,
            client,
            account?.state.id ?? null,
            'request.busy',
            null,
            this.deps.clock.now(),
          );
          return ok(undefined);
        }),
      );
      if (!released.ok) return err(UNAVAILABLE);
      return err(verified.error);
    }
    const matches = account !== null && verified.value.matches;
    // Slow work before the closing unit: the new hash (older parameters) and the token.
    const rehashed = matches && verified.value.needsRehash ? await hasher.hash(password) : null;
    const issued = matches ? this.deps.tokens.issue() : null;

    // Step 4: the closing unit (HF11).
    const closed = await this.#failClosed(context, 'closing', () =>
      unitOfWork.run(market, async (): Promise<Result<Closed, never>> => {
        const now = this.deps.clock.now();
        const current = account === null ? null : await accounts.findById(market, account.state.id);
        if (
          !matches ||
          account === null ||
          issued === null ||
          current === null ||
          current.state.credential.passwordHash !== account.state.credential.passwordHash
        ) {
          const blocks = reserved.flatMap(({ reservation: r, rule }) => {
            const until = blockAfterFailure(r, rule, now);
            return until === null ? [] : [{ reservation: r, until }];
          });
          if (blocks.length > 0) await throttles.block(market, blocks);
          await this.record(
            context,
            client,
            account?.state.id ?? null,
            'credentials.invalid',
            null,
            now,
          );
          return ok({ kind: 'refused', code: 'credentials.invalid' });
        }
        await throttles.release(
          market,
          reserved.map((r) => r.reservation),
        );
        const accountId = current.state.id;
        const refuse = async (code: Refused): Promise<Result<Closed, never>> => {
          await this.record(context, client, accountId, code, null, now);
          return ok({ kind: 'refused', code });
        };
        if (link !== null) {
          // 3.1: no link is used for a disabled account; it stays unused.
          if (current.state.status !== 'active') return refuse('account.disabled');
          if (!(await this.linkDeps!.links.consume(market, link.state.id, now))) {
            return refuse('link.rejected');
          }
          if (current.verifyEmail(now)) {
            await accounts.save(market, current);
            await this.linkDeps!.outbox.append(context, current.pendingEvents);
          }
        }
        if (!current.isEmailVerified) return refuse('email-verification-required');
        if (current.state.status !== 'active') return refuse('account.disabled');
        if (rehashed !== null && rehashed.ok) {
          current.rehashPassword(rehashed.value);
          await accounts.save(market, current);
        }
        const session = openSession({
          id: this.deps.ids.next<'Session'>(),
          marketId: market.marketId,
          accountId,
          population: 'customer',
          transport: 'cookie',
          lifetime,
          now,
        });
        await this.deps.sessions.add(market, session, issued.tokenHash);
        await this.record(context, client, accountId, 'signed-in', session.id, now);
        return ok({ kind: 'signed-in', session });
      }),
    );
    if (!closed.ok) return err(UNAVAILABLE);
    const outcome = closed.value;
    if (outcome.kind === 'refused') return err({ code: outcome.code });
    return ok({
      code: 'signed-in',
      token: issued!.token,
      absoluteLifetimeSeconds: lifetime.absoluteLifetimeSeconds,
    });
  }

  /**
   * Runs a unit after the reservation and answers access.unavailable when it throws, like the
   * reservation unit does (6.8): no session is opened and the attempt stays counted.
   */
  async #failClosed<T, E>(
    context: CallContext,
    unit: 'release' | 'closing',
    run: () => Promise<Result<T, E>>,
  ): Promise<Result<T, E | 'unavailable'>> {
    try {
      return await run();
    } catch {
      this.#logger.warn({
        msg: 'identity.sign-in.unit-unavailable',
        unit,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err('unavailable');
    }
  }

  /** One sign-in record (identity design 10.2): never the typed email or a token. */
  private async record(
    context: CallContext,
    client: SignInClient,
    accountId: Id<'Account'> | null,
    outcome: string,
    sessionId: Id<'Session'> | null,
    now: Temporal.Instant,
  ): Promise<void> {
    await this.deps.records.add(context.market, {
      id: this.deps.ids.next<'SignInRecord'>(),
      population: 'customer',
      accountId,
      outcome,
      occurredAt: now,
      address: client.address,
      sessionId,
      correlationId: context.correlationId,
    });
  }
}
