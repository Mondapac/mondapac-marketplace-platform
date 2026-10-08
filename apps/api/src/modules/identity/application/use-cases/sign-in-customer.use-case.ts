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
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { Account } from '../../domain/account';
import { parseEmailAddress } from '../../domain/email-address';
import { openSession, type Session } from '../../domain/session';
import {
  blockAfterFailure,
  reservationVerdict,
  type ThrottleReservation,
  type ThrottleRule,
} from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { SessionRepository } from '../ports/session.repository';
import type { SessionTokens, ThrottleKeys } from '../ports/session-secrets';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import type { FieldProblem } from './register-customer.use-case';

/** The raw password is at most this many bytes, so a request cannot buy an expensive hash (6.5). */
export const MAX_PASSWORD_BYTES = 1024;

/** Where the request came from, read from the socket by the controller (never a forwarded header). */
export interface SignInClient {
  /** The IPv4 address or the IPv6 /64: the key of the origin counters (HF3). */
  readonly origin: string;
  /** The full address, stored in the sign-in record (10.2). */
  readonly address: string;
}

export interface SignInCustomerInput {
  readonly email: string;
  readonly password: string;
  readonly client: SignInClient;
}

/**
 * A new session. The token goes into the cookie only; the controller never puts it in a body
 * or a log.
 */
export interface SignInCustomerOutput {
  readonly code: 'signed-in';
  readonly token: string;
  readonly absoluteLifetimeSeconds: number;
}

export type SignInCustomerFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'credentials.invalid' }
  | { readonly code: 'email-verification-required' }
  | { readonly code: 'account.disabled' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

export interface SignInCustomerDependencies {
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

type Reserved = { readonly reservation: ThrottleReservation; readonly rule: ThrottleRule };

/** What the closing unit decided. */
type Closed =
  | { readonly kind: 'signed-in'; readonly session: Session }
  | {
      readonly kind: 'refused';
      readonly code: 'credentials.invalid' | 'email-verification-required' | 'account.disabled';
    };

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * Customer sign-in (identity design 3.5, 6.3, 6.8, 10.2; CUS-02; slice 2). Rule `anonymous`: the
 * gate passes the Market's anonymous actor whoever calls (HF9). The steps of 6.3:
 *
 * 1. The generic per-origin limit ran before any identity code (the platform's rate limiter).
 * 2. **Reservation unit** (HF1): one short read-write unit counts the attempt on the three
 *    sign-in counters (`sign-in.account-origin`, `sign-in.account`, `sign-in.origin`) and reads
 *    the account by Market, population and normalised email. A counter at its threshold refuses
 *    the attempt here, without hashing, and the refusal is recorded. If the counters cannot be
 *    reached, `access.unavailable` and nothing is hashed (fail closed).
 * 3. **The password is verified outside any unit**, against a dummy hash with the current
 *    parameters when there is no account, so both paths cost one hash (HF12).
 * 4. **Closing unit**: re-reads the account (HF11). A wrong password, an unknown address, or a
 *    credential that changed since it was verified, is `credentials.invalid`: the failure stays
 *    counted and a counter that reached its limit is blocked. A correct password releases the
 *    reservation; then an unverified email is `email-verification-required` (Hassan I5: the
 *    only way in for it is the verification link, slice 3) and a disabled account is
 *    `account.disabled`; otherwise a hash with older parameters is replaced and a session with
 *    a new token is created. Every attempt writes one sign-in record (never the email).
 *
 * Refusals are `ok` outcomes of their units, so the counters and the record commit (PN1). An
 * unknown address, a wrong password and another population or Market all answer
 * `credentials.invalid` (AC 1, AC 3).
 */
export class SignInCustomer extends UseCase<
  SignInCustomerInput,
  SignInCustomerOutput,
  SignInCustomerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-in-customer',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('SignInCustomer');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SignInCustomerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SignInCustomerInput,
  ): Promise<Result<SignInCustomerOutput, SignInCustomerFailure>> {
    const { market } = context;
    const { policy, keys, unitOfWork, throttles, accounts, hasher } = this.deps;

    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const lifetime = policy.sessionLifetime(market, 'customer');
    if (lifetime === null) return err(UNAVAILABLE);

    const rules = policy.signInThrottles(market);
    const accountKey = keys.account(market, 'customer', email.value.normalized);
    const counters: readonly ThrottleCounter[] = [
      {
        kind: 'sign-in.account-origin',
        keyHash: keys.accountOrigin(
          market,
          'customer',
          email.value.normalized,
          input.client.origin,
        ),
        accountKey,
        rule: rules.accountOrigin,
      },
      { kind: 'sign-in.account', keyHash: accountKey, accountKey, rule: rules.account },
      {
        kind: 'sign-in.origin',
        keyHash: keys.origin(market, input.client.origin),
        accountKey: null,
        rule: rules.origin,
      },
    ];

    // Step 2: the reservation unit (HF1).
    let reservation: {
      readonly reserved: readonly Reserved[];
      readonly account: Account | null;
      readonly retryAfterSeconds: number | null;
    };
    try {
      const run = await unitOfWork.run(market, async () => {
        const now = this.deps.clock.now();
        const reservations = await throttles.reserve(market, counters, now);
        const reserved = reservations.map((r, index) => ({
          reservation: r,
          rule: counters[index]!.rule,
        }));
        const account = await accounts.findByEmail(market, 'customer', email.value.normalized);
        const verdict = reservationVerdict(reserved, now);
        if (!verdict.allowed) {
          await this.record(
            context,
            input.client,
            account?.state.id ?? null,
            'request.throttled',
            null,
            now,
          );
        }
        return ok({
          reserved,
          account,
          retryAfterSeconds: verdict.allowed ? null : verdict.retryAfterSeconds,
        });
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
    if (reservation.retryAfterSeconds !== null) {
      return err({ code: 'request.throttled', retryAfterSeconds: reservation.retryAfterSeconds });
    }
    const { reserved, account } = reservation;

    // Step 3: the hash check, outside any unit (HF12).
    const verified = await hasher.verify(
      input.password,
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
            input.client,
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
    const rehashed =
      matches && verified.value.needsRehash ? await hasher.hash(input.password) : null;
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
            input.client,
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
        if (!current.isEmailVerified) {
          await this.record(
            context,
            input.client,
            accountId,
            'email-verification-required',
            null,
            now,
          );
          return ok({ kind: 'refused', code: 'email-verification-required' });
        }
        if (current.state.status !== 'active') {
          await this.record(context, input.client, accountId, 'account.disabled', null, now);
          return ok({ kind: 'refused', code: 'account.disabled' });
        }
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
        await this.record(context, input.client, accountId, 'signed-in', session.id, now);
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

  /** One sign-in record (identity design 10.2): never the typed email. */
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
