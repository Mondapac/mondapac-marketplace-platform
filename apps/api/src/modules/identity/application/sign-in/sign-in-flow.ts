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
import type { SellerAccess, SellerAccessStateCode } from '../../domain/seller-access';
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
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
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

/** The populations that sign in with a password alone in Phase 2 (admins need a factor, slice 7). */
export type SignInPopulation = 'customer' | 'seller';

/** A new session. The token goes into the cookie only, never a body or a log. */
export interface SignedIn {
  readonly code: 'signed-in';
  readonly token: string;
  readonly absoluteLifetimeSeconds: number;
  /**
   * Whether the cookie outlives the browser (`Max-Age` = the absolute lifetime): always for a
   * customer; for a seller only with "keep me signed in" (identity design 6.1).
   */
  readonly persistent: boolean;
  /** The seller's access state for a seller session (F2 step 8: a limited session); else null. */
  readonly sellerAccess: SellerAccessStateCode | null;
}

export type SignInRefusal =
  | { readonly code: 'credentials.invalid' }
  | { readonly code: 'email-verification-required' }
  | { readonly code: 'account.disabled' }
  | { readonly code: 'membership.none' }
  | { readonly code: 'seller-access.suspended' }
  | { readonly code: 'link.rejected' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

/** Refusals only the seller population can meet (3.3, 6.3 step 6). */
export const SELLER_ONLY_REFUSALS: ReadonlySet<string> = new Set([
  'membership.none',
  'seller-access.suspended',
]);
export type SellerOnlyRefusal = { readonly code: 'membership.none' | 'seller-access.suspended' };

export interface SignInDependencies {
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

/** What the seller population needs on top: its membership and its seller's access (slice 5). */
export interface SellerSignInDependencies {
  readonly memberships: SellerMembershipRepository;
  readonly sellerAccess: SellerAccessRepository;
}

/** Options of one attempt. */
export interface SignInOptions {
  /** "Keep me signed in" (identity design 6.1): seller side only; ignored for a customer. */
  readonly keepSignedIn?: boolean;
}

type Reserved = { readonly reservation: ThrottleReservation; readonly rule: ThrottleRule };

type Refused =
  | 'credentials.invalid'
  | 'email-verification-required'
  | 'account.disabled'
  | 'membership.none'
  | 'seller-access.suspended'
  | 'link.rejected';

/** What the closing unit decided. */
type Closed =
  | {
      readonly kind: 'signed-in';
      readonly session: Session;
      readonly sellerAccess: SellerAccessStateCode | null;
    }
  | { readonly kind: 'refused'; readonly code: Refused };

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * The sign-in sequence of identity design 6.3 (CUS-02, SEL-04; slices 2, 3 and 5) for one
 * population, shared by the use cases that run it: `SignInCustomer` and `SignInSeller` with the
 * typed email, `ConfirmCustomerEmail` and `ConfirmSellerEmail` with the link's token in its place
 * (3.2, 6.7 option B; 8.6 row 3). Not a use case itself: each use case declares its own access
 * rule and calls {@link run} from its `handle`. The population is fixed per instance: the
 * account is looked up within it, so the other population answers `credentials.invalid` (AC 3).
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
 *    `account.disabled`. A seller-side account (slice 5) then needs an active membership
 *    (`membership.none`) and a seller that is not suspended (`seller-access.suspended`); both
 *    are checked before a link is consumed, so a refused link stays unused. A link that
 *    verifies a self-registered owner records `identity.seller-registered.v1` on the seller
 *    (8.2, M4). Then a hash with older parameters is replaced and a session with a new token is
 *    created; a seller session carries its seller and the answer its access state (`pending`
 *    and `rejected` sign in to a limited session, 3.3). Every attempt writes one sign-in record
 *    (never the email).
 *
 * Refusals are `ok` outcomes of their units, so the counters, the record and the block commit
 * (PN1).
 */
export class SignInFlow {
  readonly #logger = new Logger('SignIn');

  constructor(
    private readonly population: SignInPopulation,
    private readonly deps: SignInDependencies,
    private readonly linkDeps: LinkSignInDependencies | null = null,
    private readonly sellerDeps: SellerSignInDependencies | null = null,
  ) {
    if (population === 'seller' && sellerDeps === null) {
      throw new Error('SignInFlow: the seller population needs the seller dependencies');
    }
  }

  async run(
    context: CallContext,
    identifier: SignInIdentifier,
    password: string,
    client: SignInClient,
    options: SignInOptions = {},
  ): Promise<Result<SignedIn, SignInRefusal>> {
    const { market } = context;
    const { policy, keys, unitOfWork, throttles, accounts, hasher } = this.deps;
    const population = this.population;
    if (identifier.kind === 'link' && this.linkDeps === null) {
      throw new Error('SignInFlow: the link variant needs the link dependencies');
    }
    // 6.1: "keep me signed in" is seller side only, and only where the Market offers it.
    const kept =
      population === 'seller' && options.keepSignedIn === true
        ? policy.sessionLifetime(market, population, true)
        : null;
    const lifetime = kept ?? policy.sessionLifetime(market, population);
    if (lifetime === null) return err(UNAVAILABLE);
    const persistent = population === 'customer' || kept !== null;
    const rules = policy.signInThrottles(market);
    const originCounter: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: keys.origin(market, client.origin),
      accountKey: null,
      rule: rules.origin,
    };
    const countersFor = (emailNormalized: string): readonly ThrottleCounter[] => {
      const accountKey = keys.account(market, population, emailNormalized);
      return [
        {
          kind: 'sign-in.account-origin',
          keyHash: keys.accountOrigin(market, population, emailNormalized, client.origin),
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
          account = await accounts.findByEmail(market, population, identifier.email.normalized);
        } else {
          link =
            identifier.tokenHash === null
              ? null
              : await this.linkDeps!.links.findByTokenHash(market, identifier.tokenHash);
          account =
            link !== null && link.usableFor('verify-email', now)
              ? await accounts.findById(market, link.state.accountId)
              : null;
          if (account !== null && account.state.population !== population) account = null;
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
        // 3.1: no link is used for a disabled account; it stays unused.
        if (link !== null && current.state.status !== 'active') return refuse('account.disabled');
        if (link === null && !current.isEmailVerified) {
          return refuse('email-verification-required');
        }
        if (current.state.status !== 'active') return refuse('account.disabled');
        // Step 6 for the seller side (3.3): an active membership and a seller not suspended.
        // Read before a link is consumed, so a refused link stays unused.
        let seller: SellerAccess | null = null;
        if (population === 'seller') {
          const { memberships, sellerAccess } = this.sellerDeps!;
          const membership = await memberships.findActiveByAccount(market, accountId);
          seller =
            membership === null
              ? null
              : await sellerAccess.findById(market, membership.state.sellerId);
          if (seller === null) return refuse('membership.none');
          if (!seller.allowsSignIn) return refuse('seller-access.suspended');
        }
        if (link !== null) {
          // Bound to the link read in the reservation unit: a link re-issued (or consumed)
          // since then has another version, and this use is refused (Hassan L1).
          const consumed = await this.linkDeps!.links.consume(
            market,
            link.state.id,
            link.state.version,
            now,
          );
          if (!consumed) return refuse('link.rejected');
          // 8.2, M4: the owner's verification publishes a self-registered seller, once.
          if (current.verifyEmail(now) && seller !== null && seller.state.origin === 'self') {
            seller.recordRegistered(accountId, now);
          }
        }
        if (rehashed !== null && rehashed.ok) current.rehashPassword(rehashed.value);
        // One save for every change of this unit (Hassan L2): the verified email and a re-hash
        // step the version twice, and a second save of the same object would be stale.
        if (current.state.version !== current.persistedVersion) {
          await accounts.save(market, current);
        }
        if (seller !== null && seller.state.version !== seller.persistedVersion) {
          await this.sellerDeps!.sellerAccess.save(market, seller);
        }
        const events = [...current.pendingEvents, ...(seller?.pendingEvents ?? [])];
        if (events.length > 0) await this.linkDeps!.outbox.append(context, events);
        const session = openSession({
          id: this.deps.ids.next<'Session'>(),
          marketId: market.marketId,
          accountId,
          population,
          sellerId: seller?.state.sellerId ?? null,
          transport: 'cookie',
          lifetime,
          now,
        });
        await this.deps.sessions.add(market, session, issued.tokenHash);
        await this.record(context, client, accountId, 'signed-in', session.id, now);
        return ok({ kind: 'signed-in', session, sellerAccess: seller?.state.state ?? null });
      }),
    );
    if (!closed.ok) return err(UNAVAILABLE);
    const outcome = closed.value;
    if (outcome.kind === 'refused') return err({ code: outcome.code });
    return ok({
      code: 'signed-in',
      token: issued!.token,
      absoluteLifetimeSeconds: lifetime.absoluteLifetimeSeconds,
      persistent,
      sellerAccess: outcome.sellerAccess,
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
      population: this.population,
      accountId,
      outcome,
      occurredAt: now,
      address: client.address,
      sessionId,
      correlationId: context.correlationId,
    });
  }
}
