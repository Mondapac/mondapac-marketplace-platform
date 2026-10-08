import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result, Temporal } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { Account } from '../../domain/account';
import {
  checkNewPassword,
  MAX_PASSWORD_BYTES,
  type PasswordRejected,
} from '../../domain/password-policy';
import type { Session } from '../../domain/session';
import {
  blockAfterFailure,
  reservationVerdict,
  type ThrottleReservation,
  type ThrottleRule,
} from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { CommonPasswordList } from '../ports/common-password-list';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { SessionTokens, ThrottleKeys } from '../ports/session-secrets';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';

export interface ChangePasswordInput {
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly client: SignInClient;
}

/**
 * The password was replaced and the current session rotated: its new token goes into the cookie
 * only (never a body or a log). `cookieMaxAgeSeconds` is what is left of the session's absolute
 * lifetime when its cookie outlives the browser, or null for a browser-session cookie (a seller
 * session without "keep me signed in", identity design 6.1).
 */
export interface ChangePasswordOutput {
  readonly code: 'password-changed';
  readonly token: string;
  readonly cookieMaxAgeSeconds: number | null;
}

export type ChangePasswordFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'password.current-incorrect' }
  | PasswordRejected
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'session.invalid' }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

export interface ChangePasswordDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  /** HF11: the closing unit voids the account's open sign-in challenges. */
  readonly challenges: SignInChallengeRepository;
  readonly links: OneTimeLinkRepository;
  readonly throttles: ThrottleRepository;
  readonly records: SignInRecordRepository;
  readonly keys: ThrottleKeys;
  readonly tokens: SessionTokens;
  readonly outbox: OutboxWriter;
  readonly hasher: PasswordHasher;
  readonly commonPasswords: CommonPasswordList;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

type Reserved = { readonly reservation: ThrottleReservation; readonly rule: ThrottleRule };

/** What the closing unit decided. */
type Closed =
  | { readonly kind: 'changed'; readonly session: Session; readonly revokedSessions: number }
  | { readonly kind: 'refused'; readonly code: 'password.current-incorrect' | 'session.invalid' };

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * A signed-in user changes the own password (identity design 3.5, 6.2, 6.5; brief flow «ج», AC
 * 18, AC 32; `ux.md` F3 step 5, B4; slice 4). Rule `own-resources`, allowed while a seller is not
 * approved (the allow-list of 5.2: "change of the own password"). The account is the actor's;
 * nothing in the input names one.
 *
 * Decided by the design (6.5, 3.5, 6.2): the current password is required in the same request
 * (an admin needs a code too, Hassan I2 (b): that path comes with admin sign-in in slice 7b, so
 * an admin is refused until then); **every other session of the account is revoked**
 * (`password-changed`), and **the current session continues with a new token** (rotation), so a
 * token copied before the change stops working.
 *
 * Guessing the current password is throttled as sign-in is (HF1, 6.8): the reservation unit
 * counts `sign-in.account-origin`, `sign-in.account` and `sign-in.origin` for the account's
 * address before any hash, and a counter at its limit refuses without hashing; unreachable:
 * `access.unavailable`. A wrong current password stays counted and blocks a counter that reaches
 * its limit; a correct one gives the reservation back. The new password's rules (6.5) are
 * checked before the current one is verified, so a refused new password costs no hash.
 *
 * The closing unit (READ COMMITTED) takes the account's credential lock first (`lockCredential`;
 * Hassan slice-2 N1), reads the account again and refuses when the hash it verified is no longer
 * the stored one (a concurrent reset or change won). Then the current session is rotated (if it
 * was revoked meanwhile: `session.invalid`, nothing changes), the new hash saved, the other
 * sessions revoked, the reservation given back and `identity.account-password-changed.v1`
 * (`change`) recorded, which sends the "password changed" mail (E13). The same unit cancels the
 * account's unused reset link (Hassan L2), so a link requested before the change stops working,
 * and voids every open sign-in challenge of the account (HF11; Hassan I2 (d)).
 *
 * Every attempt that reaches the current password leaves a sign-in record (identity design 10.2;
 * Hassan L3) in the unit that decides it: `password.current-incorrect` or `password-changed`,
 * with the client's address, the session and the correlation id. A closing unit that throws gives
 * the reservation back before the error goes on (Mojtaba, slice 4).
 */
export class ChangePassword extends UseCase<
  ChangePasswordInput,
  ChangePasswordOutput,
  ChangePasswordFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.change-password',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('ChangePassword');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangePasswordDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ChangePasswordInput,
  ): Promise<Result<ChangePasswordOutput, ChangePasswordFailure>> {
    const { market, actor } = context;
    const { unitOfWork, accounts, throttles, keys, policy, hasher } = this.deps;
    // The gate admits only an authenticated actor under own-resources. An admin needs a code
    // with the password (6.5; Hassan I2 (b)), which slice 7b brings: refused until then.
    if (actor.kind !== 'authenticated' || actor.population === 'admin') {
      return err({ code: 'access.denied' });
    }
    const population = actor.population;
    const tooLong = (['currentPassword', 'newPassword'] as const).filter(
      (field) => Buffer.byteLength(input[field], 'utf8') > MAX_PASSWORD_BYTES,
    );
    if (tooLong.length > 0) {
      return err({
        code: 'validation.failed',
        fields: tooLong.map((path) => ({ path, code: 'length' })),
      });
    }
    const rules = policy.signInThrottles(market);

    // 1. The reservation unit (HF1): count the attempt, read the actor's account.
    type Reservation = {
      readonly reserved: readonly Reserved[];
      readonly account: Account | null;
      readonly throttled: number | null;
    };
    let reserved: Reservation;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Reservation, never>> => {
        const now = this.deps.clock.now();
        const account = await accounts.findById(market, actor.accountId);
        if (account === null) return ok({ reserved: [], account, throttled: null });
        const email = account.state.email.normalized;
        const accountKey = keys.account(market, population, email);
        const counters: readonly ThrottleCounter[] = [
          {
            kind: 'sign-in.account-origin',
            keyHash: keys.accountOrigin(market, population, email, input.client.origin),
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
        const reservations = await throttles.reserve(market, counters, now);
        const reserved = reservations.map((reservation, index) => ({
          reservation,
          rule: counters[index]!.rule,
        }));
        const verdict = reservationVerdict(reserved, now);
        return ok({
          reserved,
          account,
          throttled: verdict.allowed ? null : verdict.retryAfterSeconds,
        });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reserved = run.value;
    } catch {
      this.log('identity.change-password.throttle-unavailable', context, {});
      return err(UNAVAILABLE);
    }
    const { account } = reserved;
    // The session's account always exists (a cascade removes its sessions with it).
    if (account === null) return err({ code: 'session.invalid' });
    if (reserved.throttled !== null) {
      return err({ code: 'request.throttled', retryAfterSeconds: reserved.throttled });
    }
    const reservations = reserved.reserved.map((r) => r.reservation);

    // 2. The new password's rules; the current password verified outside any unit; the hash.
    const checked = checkNewPassword(
      input.newPassword,
      policy.passwordRules(market),
      { email: account.state.email.normalized, displayName: account.state.displayName },
      (comparable) => this.deps.commonPasswords.isCommon(comparable),
    );
    if (!checked.ok) return this.releasing(context, reservations, checked.error);
    const verified = await hasher.verify(
      input.currentPassword,
      account.state.credential.passwordHash,
    );
    if (!verified.ok) return this.releasing(context, reservations, verified.error);
    if (!verified.value.matches) {
      // A wrong guess stays counted; a counter that reached its limit is blocked (6.8).
      const blocked = await this.failClosed(context, () =>
        unitOfWork.run(market, async () => {
          const now = this.deps.clock.now();
          const blocks = reserved.reserved.flatMap(({ reservation, rule }) => {
            const until = blockAfterFailure(reservation, rule, now);
            return until === null ? [] : [{ reservation, until }];
          });
          if (blocks.length > 0) await throttles.block(market, blocks);
          await this.record(context, input.client, 'password.current-incorrect', now);
          return ok(undefined);
        }),
      );
      if (!blocked) return err(UNAVAILABLE);
      this.log('identity.change-password.current-incorrect', context, {});
      return err({ code: 'password.current-incorrect' });
    }
    const hashed = await hasher.hash(input.newPassword);
    if (!hashed.ok) return this.releasing(context, reservations, hashed.error);
    const issued = this.deps.tokens.issue();
    const verifiedHash = account.state.credential.passwordHash;

    // 3. The closing unit.
    const closed = await this.closing(context, reservations, () =>
      unitOfWork.run(market, async (): Promise<Result<Closed, never>> => {
        const now = this.deps.clock.now();
        const locked = await accounts.lockCredential(market, actor.accountId);
        const current = locked ? await accounts.findById(market, actor.accountId) : null;
        if (current === null) return ok({ kind: 'refused', code: 'session.invalid' });
        if (current.state.credential.passwordHash !== verifiedHash) {
          // A reset or another change committed since the current password was verified.
          await throttles.release(market, reservations);
          await this.record(context, input.client, 'password.current-incorrect', now);
          return ok({ kind: 'refused', code: 'password.current-incorrect' });
        }
        const replaced = current.replacePassword({
          passwordHash: hashed.value,
          now,
          cause: 'change',
        });
        if (!replaced.ok) return ok({ kind: 'refused', code: 'session.invalid' });
        const { sessions } = this.deps;
        // 6.2: the current session continues with a new token; revoked meanwhile, nothing changes.
        if (!(await sessions.rotate(market, actor.sessionId, actor.accountId, issued.tokenHash))) {
          await throttles.release(market, reservations);
          return ok({ kind: 'refused', code: 'session.invalid' });
        }
        const session = await sessions.findById(market, actor.sessionId);
        if (session === null) return ok({ kind: 'refused', code: 'session.invalid' });
        await accounts.save(market, current);
        // Hassan L2: a reset link requested before the change stops working with it.
        await this.deps.links.cancelUnused(market, actor.accountId, 'reset-password');
        // HF11, Hassan I2 (d): a challenge opened with the old password can never complete.
        await this.deps.challenges.voidAllOf(market, actor.accountId);
        const revokedSessions = await sessions.revokeAllOf(
          market,
          actor.accountId,
          'password-changed',
          now,
          actor.sessionId,
        );
        await throttles.release(market, reservations);
        await this.record(context, input.client, 'password-changed', now);
        await this.deps.outbox.append(context, current.pendingEvents);
        return ok({ kind: 'changed', session, revokedSessions });
      }),
    );
    if (!closed.ok) return err(UNAVAILABLE);
    const outcome = closed.value;
    if (outcome.kind === 'refused') {
      this.log('identity.change-password.refused', context, { reason: outcome.code });
      return err({ code: outcome.code });
    }
    this.log('identity.change-password.done', context, {
      revokedSessions: outcome.revokedSessions,
    });
    return ok({
      code: 'password-changed',
      token: issued.token,
      cookieMaxAgeSeconds: this.cookieMaxAge(context, outcome.session),
    });
  }

  /**
   * The cookie of the rotated session (identity design 6.1): a customer's always outlives the
   * browser; a seller's only when the session was opened with "keep me signed in", which is
   * when its absolute lifetime is longer than the Market's default seller lifetime. Either way
   * it never outlives the session's absolute expiry, which never moves (3.5).
   */
  private cookieMaxAge(context: CallContext, session: Session): number | null {
    const standard = this.deps.policy.sessionLifetime(context.market, session.population);
    const lifetime = session.createdAt.until(session.absoluteExpiresAt).total({ unit: 'seconds' });
    const persistent =
      session.population === 'customer' ||
      (standard !== null && lifetime > standard.absoluteLifetimeSeconds);
    if (!persistent) return null;
    const left = this.deps.clock.now().until(session.absoluteExpiresAt).total({ unit: 'seconds' });
    return Math.max(1, Math.floor(left));
  }

  /**
   * Runs the closing unit. When it throws (a lock timeout, exhausted retries, a lost connection)
   * nothing of it was kept, so the reservation is given back, best effort, before the error goes
   * on to its usual answer (Mojtaba, slice 4).
   */
  private async closing<T>(
    context: CallContext,
    reservations: readonly ThrottleReservation[],
    run: () => Promise<Result<T, never>>,
  ): Promise<Result<T, never>> {
    try {
      return await run();
    } catch (error) {
      this.log('identity.change-password.closing-failed', context, {});
      await this.failClosed(context, () =>
        this.deps.unitOfWork.run(context.market, async () => {
          await this.deps.throttles.release(context.market, reservations);
          return ok(undefined);
        }),
      );
      throw error;
    }
  }

  /**
   * One sign-in record of the password change (identity design 10.2; Hassan L3): the actor's
   * account and session, the client's address and the correlation id; never a password.
   */
  private async record(
    context: CallContext,
    client: SignInClient,
    outcome: 'password.current-incorrect' | 'password-changed',
    now: Temporal.Instant,
  ): Promise<void> {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population === 'admin') return;
    await this.deps.records.add(context.market, {
      id: this.deps.ids.next<'SignInRecord'>(),
      population: actor.population,
      accountId: actor.accountId,
      outcome,
      occurredAt: now,
      address: client.address,
      sessionId: actor.sessionId,
      correlationId: context.correlationId,
    });
  }

  /** Gives the reservation back (nothing was guessed) and answers `failure`. */
  private async releasing<F extends ChangePasswordFailure>(
    context: CallContext,
    reservations: readonly ThrottleReservation[],
    failure: F,
  ): Promise<Result<never, F | typeof UNAVAILABLE>> {
    const released = await this.failClosed(context, () =>
      this.deps.unitOfWork.run(context.market, async () => {
        await this.deps.throttles.release(context.market, reservations);
        return ok(undefined);
      }),
    );
    return err(released ? failure : UNAVAILABLE);
  }

  /** Runs a counter unit; false when it failed or threw (fail closed, 6.8). */
  private async failClosed(
    context: CallContext,
    run: () => Promise<Result<void, never>>,
  ): Promise<boolean> {
    try {
      return (await run()).ok;
    } catch {
      this.log('identity.change-password.unit-unavailable', context, {});
      return false;
    }
  }

  /** Ids, codes and counts only: never the address, a token or a password (P 12.3). */
  private log(msg: string, context: CallContext, fields: Record<string, string | number>): void {
    const actor = context.actor;
    this.#logger.log({
      msg,
      ...fields,
      ...(actor.kind === 'authenticated'
        ? { accountId: actor.accountId, population: actor.population }
        : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
