import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Account } from '../../domain/account';
import { encodeBase32, otpauthUri } from '../../domain/otpauth';
import { MAX_PASSWORD_BYTES } from '../../domain/password-policy';
import { SecondFactor } from '../../domain/second-factor';
import { issueChallenge } from '../../domain/sign-in-challenge';
import {
  blockAfterFailure,
  reservationVerdict,
  type ThrottleReservation,
  type ThrottleRule,
} from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorSecrets } from '../ports/second-factor-secrets';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';

export interface StartSellerSecondFactorEnrolmentInput {
  /** The signed-in holder's own password: a session alone never starts an enrolment (HF6). */
  readonly password: string;
  readonly client: SignInClient;
}

/**
 * A pending factor exists. The secret is shown once, here, as base32 text and inside the
 * `otpauth://` URI for the panel's QR code (drawn by the panel, never a remote service: 7.1);
 * the challenge's token is posted back with the first code.
 */
export interface StartSellerSecondFactorEnrolmentOutput {
  readonly code: 'second-factor-enrolment-started';
  readonly challengeToken: string;
  readonly expiresAt: Temporal.Instant;
  readonly secret: string;
  readonly otpauthUri: string;
}

export type StartSellerSecondFactorEnrolmentFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'password.current-incorrect' }
  /** The account already has an active factor: remove it first. */
  | { readonly code: 'second-factor.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'session.invalid' }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

export interface StartSellerSecondFactorEnrolmentDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly factors: SecondFactorRepository;
  readonly challenges: SignInChallengeRepository;
  readonly throttles: ThrottleRepository;
  readonly records: SignInRecordRepository;
  readonly keys: ThrottleKeys;
  readonly challengeTokens: OpaqueTokens;
  readonly secrets: SecondFactorSecrets;
  readonly hasher: PasswordHasher;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

type Reserved = { readonly reservation: ThrottleReservation; readonly rule: ThrottleRule };

type Closed =
  | { readonly kind: 'started'; readonly expiresAt: Temporal.Instant }
  | { readonly kind: 'refused'; readonly code: 'password.current-incorrect' | 'session.invalid' }
  | { readonly kind: 'active' };

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * Starts the enrolment of a second factor for the signed-in seller-side account (identity design
 * 3.6 `none` → `pending`, HF6, 7.1; owner decision 2026-10-08: optional for a seller at launch,
 * compulsory before payouts; the admin's {@link StartSecondFactorEnrolment} from a mailed link is
 * the model). Rule `own-resources`, approved sellers only: the account is the actor's, nothing in
 * the input names one. A session alone never starts an enrolment (HF6): the account's password
 * is needed in the same request, so a hijacked session cannot bind a device the owner does not
 * hold.
 *
 * 1. **Reservation unit**: the account, and the sign-in counters of its address and origin
 *    reserved as {@link ChangePassword} does (guessing the password here is throttled like
 *    guessing it at sign-in); a counter at its limit refuses without hashing.
 * 2. The password is verified outside any unit (HF12); a wrong one stays counted and blocks a
 *    counter at its limit. A new 160-bit secret is sealed under the account's key and the
 *    challenge's token minted, outside any unit.
 * 3. **Closing unit**: the credential lock, the account read again and the hash compared (HF11).
 *    An active factor refuses the start (`second-factor.unavailable`: remove it first). A stale
 *    pending factor is replaced in the same unit. An enrolment challenge (purpose
 *    `second-factor-enrolment`, bound to the credential's time) is stored and the reservation
 *    given back.
 *
 * The secret, the token and the password are never logged, stored in clear or put in an event.
 */
export class StartSellerSecondFactorEnrolment extends UseCase<
  StartSellerSecondFactorEnrolmentInput,
  StartSellerSecondFactorEnrolmentOutput,
  StartSellerSecondFactorEnrolmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.start-seller-second-factor-enrolment',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('StartSellerSecondFactorEnrolment');

  constructor(
    gate: UseCaseGate,
    private readonly deps: StartSellerSecondFactorEnrolmentDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: StartSellerSecondFactorEnrolmentInput,
  ): Promise<
    Result<StartSellerSecondFactorEnrolmentOutput, StartSellerSecondFactorEnrolmentFailure>
  > {
    const { market, actor } = context;
    const { unitOfWork, throttles, keys, policy } = this.deps;
    if (actor.kind !== 'authenticated' || actor.population !== 'seller') {
      return err({ code: 'access.denied' });
    }
    const accountId = actor.accountId;
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const challengePolicy = policy.challengePolicy(market);
    if (challengePolicy === null) return err(UNAVAILABLE);
    const rules = policy.signInThrottles(market);

    // 1. The reservation unit.
    type Reservation = {
      readonly reserved: readonly Reserved[];
      readonly account: Account | null;
      readonly throttled: number | null;
    };
    let reserved: Reservation;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Reservation, never>> => {
        const now = this.deps.clock.now();
        const account = await this.deps.accounts.findById(market, accountId);
        if (account === null || account.state.population !== 'seller') {
          return ok({ reserved: [], account: null, throttled: null });
        }
        const email = account.state.email.normalized;
        const accountKey = keys.account(market, 'seller', email);
        const counters: readonly ThrottleCounter[] = [
          {
            kind: 'sign-in.account-origin',
            keyHash: keys.accountOrigin(market, 'seller', email, input.client.origin),
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
        const held = reservations.map((reservation, index) => ({
          reservation,
          rule: counters[index]!.rule,
        }));
        const verdict = reservationVerdict(held, now);
        return ok({
          reserved: held,
          account,
          throttled: verdict.allowed ? null : verdict.retryAfterSeconds,
        });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reserved = run.value;
    } catch {
      this.log('identity.seller-second-factor-enrolment.throttle-unavailable', context);
      return err(UNAVAILABLE);
    }
    const { account } = reserved;
    // The session's account always exists (a cascade removes its sessions with it).
    if (account === null || account.state.status !== 'active') {
      return err({ code: 'session.invalid' });
    }
    if (reserved.throttled !== null) {
      return err({ code: 'request.throttled', retryAfterSeconds: reserved.throttled });
    }
    const reservations = reserved.reserved.map((r) => r.reservation);

    // 2. The password, outside any unit; then the secret and the challenge's token.
    const verified = await this.deps.hasher.verify(
      input.password,
      account.state.credential.passwordHash,
    );
    if (!verified.ok) {
      return (await this.release(context, reservations)) ? err(verified.error) : err(UNAVAILABLE);
    }
    if (!verified.value.matches) {
      const counted = await this.quietly(context, () =>
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
      return counted ? err({ code: 'password.current-incorrect' }) : err(UNAVAILABLE);
    }
    const secret = this.deps.secrets.newSecret();
    const issued = this.deps.challengeTokens.issue();
    let sealed: string;
    let shown: { readonly secret: string; readonly uri: string };
    try {
      sealed = await this.deps.secrets.seal(market, accountId, secret);
      shown = {
        secret: encodeBase32(secret),
        uri: otpauthUri({
          issuer: policy.mailSender(market).name,
          accountName: account.state.email.typed,
          secret,
        }),
      };
    } catch (error) {
      await this.release(context, reservations);
      throw error;
    } finally {
      secret.fill(0);
    }
    const verifiedHash = account.state.credential.passwordHash;

    // 3. The closing unit.
    let closed: Result<Closed, never>;
    try {
      closed = await unitOfWork.run(market, async (): Promise<Result<Closed, never>> => {
        const now = this.deps.clock.now();
        const locked = await this.deps.accounts.lockCredential(market, accountId);
        const current = locked ? await this.deps.accounts.findById(market, accountId) : null;
        if (current === null || current.state.status !== 'active') {
          await throttles.release(market, reservations);
          return ok({ kind: 'refused', code: 'session.invalid' });
        }
        if (current.state.credential.passwordHash !== verifiedHash) {
          await throttles.release(market, reservations);
          await this.record(context, input.client, 'password.current-incorrect', now);
          return ok({ kind: 'refused', code: 'password.current-incorrect' });
        }
        const existing = await this.deps.factors.findByAccount(market, accountId);
        if (existing !== null && existing.isActive) {
          await throttles.release(market, reservations);
          return ok({ kind: 'active' });
        }
        // A stale pending factor gives way to the new one, in this unit.
        if (existing !== null) {
          await this.deps.factors.removeOf(market, accountId);
          // An earlier enrolment challenge must not carry over to the new secret.
          await this.deps.challenges.voidAllOf(market, accountId);
        }
        await this.deps.factors.add(
          market,
          SecondFactor.startEnrolment({
            id: this.deps.ids.next<'SecondFactor'>(),
            marketId: market.marketId,
            accountId,
            secretCiphertext: sealed,
            now,
          }),
        );
        const challenge = issueChallenge({
          id: this.deps.ids.next<'SignInChallenge'>(),
          marketId: market.marketId,
          accountId,
          purpose: 'second-factor-enrolment',
          credentialChangedAt: current.state.credential.changedAt,
          policy: challengePolicy,
          now,
        });
        await this.deps.challenges.add(market, challenge, issued.tokenHash);
        await throttles.release(market, reservations);
        await this.record(context, input.client, 'second-factor-enrolment-started', now);
        return ok({ kind: 'started', expiresAt: challenge.expiresAt });
      });
    } catch (error) {
      this.log('identity.seller-second-factor-enrolment.closing-failed', context);
      await this.release(context, reservations);
      throw error;
    }
    if (!closed.ok) return err(UNAVAILABLE);
    const outcome = closed.value;
    if (outcome.kind === 'refused') {
      this.log('identity.seller-second-factor-enrolment.refused', context, outcome.code);
      return err({ code: outcome.code });
    }
    if (outcome.kind === 'active') {
      this.log('identity.seller-second-factor-enrolment.refused', context, 'active');
      return err({ code: 'second-factor.unavailable' });
    }
    this.log('identity.seller-second-factor-enrolment.started', context);
    return ok({
      code: 'second-factor-enrolment-started',
      challengeToken: issued.token,
      expiresAt: outcome.expiresAt,
      secret: shown.secret,
      otpauthUri: shown.uri,
    });
  }

  private async record(
    context: CallContext,
    client: SignInClient,
    outcome: string,
    now: Temporal.Instant,
  ): Promise<void> {
    const { actor } = context;
    await this.deps.records.add(context.market, {
      id: this.deps.ids.next<'SignInRecord'>(),
      population: 'seller',
      accountId: actor.kind === 'authenticated' ? actor.accountId : null,
      outcome,
      occurredAt: now,
      address: client.address,
      sessionId: null,
      correlationId: context.correlationId,
    });
  }

  /** Gives the reservation back (nothing was guessed); false when its unit failed. */
  private release(
    context: CallContext,
    reservations: readonly ThrottleReservation[],
  ): Promise<boolean> {
    return this.quietly(context, () =>
      this.deps.unitOfWork.run(context.market, async () => {
        await this.deps.throttles.release(context.market, reservations);
        return ok(undefined);
      }),
    );
  }

  /** Runs a counter unit; false when it failed or threw (fail closed, 6.8). */
  private async quietly(
    context: CallContext,
    run: () => Promise<Result<void, never>>,
  ): Promise<boolean> {
    try {
      return (await run()).ok;
    } catch {
      this.log('identity.seller-second-factor-enrolment.unit-unavailable', context);
      return false;
    }
  }

  /** Codes only: never the address, the token, the secret or a password (P 12.3). */
  private log(msg: string, context: CallContext, outcome?: string): void {
    this.#logger.log({
      msg,
      ...(outcome === undefined ? {} : { outcome }),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
