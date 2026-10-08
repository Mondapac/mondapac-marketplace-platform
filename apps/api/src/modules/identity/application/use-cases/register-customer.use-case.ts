import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result, Temporal } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { TransactionConflictError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { Account } from '../../domain/account';
import { parseEmailAddress, type EmailAddress } from '../../domain/email-address';
import { checkNewPassword, type PasswordRejected } from '../../domain/password-policy';
import type { AccountRepository } from '../ports/account.repository';
import type { CommonPasswordList } from '../ports/common-password-list';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';

/** The request's body. */
export interface RegisterCustomerRequest {
  readonly email: string;
  readonly password: string;
}

export interface RegisterCustomerInput extends RegisterCustomerRequest {
  /**
   * The IPv4 address or the IPv6 /64 of the client, read from the socket by the controller
   * (never a forwarded header): the key of the `mail.origin` counter (identity design 6.8).
   */
  readonly origin: string;
}

/** The one answer for every address, new or known (AC 21; identity design 6.7, 8.6 row 1). */
export type RegisterCustomerOutput = { readonly code: 'sign-up.accepted' };

/** A field the request got wrong; never its value (identity design 5.2). */
export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

export type RegisterCustomerFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | PasswordRejected
  | PasswordHasherBusy;

/** The ports the use case needs, bound by `IdentityModule`. */
export interface RegisterCustomerDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly outbox: OutboxWriter;
  readonly hasher: PasswordHasher;
  readonly commonPasswords: CommonPasswordList;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Customer sign-up (identity design 3.1, 3.2, 6.5, 6.7; CUS-01; slice 1d). Rule `anonymous`:
 * no authentication is required, and the gate passes the Market's anonymous actor (HF9).
 *
 * HF12, one answer whatever the address: after the checks that depend only on the request,
 * the password is hashed **before any read**, then the mail counters are written, and then one
 * serializable read-write unit runs (HF8: it inserts into `accounts`):
 *
 * - a new address: an active, unverified customer account without a display name, its
 *   credential and its data key; `identity.customer-account-registered.v1`;
 * - an unverified account: the password is replaced and the purge anchor restarts;
 *   `identity.sign-up-repeated.v1` (`unverified-replaced`);
 * - a verified account: nothing changes but the notice instant, at most once per the Market's
 *   interval; `identity.sign-up-repeated.v1` (`verified-notice`). Within the interval nothing of
 *   the account changes.
 *
 * Every branch counts the mail first (Hassan L4; identity design 6.7, 6.8): one attempt on
 * `mail.account` (the address) and `mail.origin`, in a short READ COMMITTED unit of its own
 * (the counters' isolation, data design 3.5), so every branch writes and costs the same: one
 * hash, the counter unit and the serializable unit. Sign-up is never refused by them: what a
 * counter above its limit stops is the mail (slice 3).
 *
 * Every branch answers `sign-up.accepted`. Two concurrent sign-ups of the same new address end
 * as if they had run one after the other: PostgreSQL usually refuses the second insert with a
 * serialisation failure, the unit runs `work` again (P 3.1 row 7) and it takes the repeat
 * branch (the later password stands); if the unique key refuses it instead, it answers the
 * same and changes nothing (the earlier password stands). The hash is never recomputed on a
 * retry: it was made before the unit. When the retries are exhausted (`conflict.retry`), a
 * structured line `identity.register-customer.conflict-retry` counts it (Mojtaba N-a).
 */
export class RegisterCustomer extends UseCase<
  RegisterCustomerInput,
  RegisterCustomerOutput,
  RegisterCustomerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.register-customer',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('RegisterCustomer');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegisterCustomerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RegisterCustomerInput,
  ): Promise<Result<RegisterCustomerOutput, RegisterCustomerFailure>> {
    const { market } = context;
    const { policy, hasher } = this.deps;

    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    // A customer has no display name, so only the email is compared (identity design 6.5).
    const checked = checkNewPassword(
      input.password,
      policy.passwordRules(market),
      { email: email.value.normalized, displayName: null },
      (comparable) => this.deps.commonPasswords.isCommon(comparable),
    );
    if (!checked.ok) return err(checked.error);

    // HF12: hashed before any read, outside every unit (platform persistence 3.1 row 5).
    const hashed = await hasher.hash(input.password);
    if (!hashed.ok) return err(hashed.error);

    const now = this.deps.clock.now();
    const noticeHours = policy.existingAccountNoticeHours(market);
    const mail = policy.mailThrottles(market);
    const accountKey = this.deps.keys.account(market, 'customer', email.value.normalized);
    const mailCounters: readonly ThrottleCounter[] = [
      { kind: 'mail.account', keyHash: accountKey, accountKey, rule: mail.account },
      {
        kind: 'mail.origin',
        keyHash: this.deps.keys.origin(market, input.origin),
        accountKey: null,
        rule: mail.origin,
      },
    ];
    let stored: Result<void, 'email-taken' | 'invalid'>;
    try {
      // L4: every branch counts the mail, in a short READ COMMITTED unit of its own, so a burst
      // of sign-ups from one origin waits on the counter row instead of failing serialisation.
      await this.deps.unitOfWork.run(market, async () => {
        await this.deps.throttles.reserve(market, mailCounters, now);
        return ok(undefined);
      });
      stored = await this.store(context, email.value, hashed.value, now, noticeHours);
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        this.#logger.warn({
          msg: 'identity.register-customer.conflict-retry',
          metric: 'conflict.retry',
          useCase: RegisterCustomer.access.name,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
      throw error;
    }
    if (!stored.ok && stored.error === 'invalid') {
      return err({ code: 'validation.failed', fields: [] });
    }
    return ok({ code: 'sign-up.accepted' });
  }

  /** The one serializable unit of every branch (HF8, HF12). */
  private async store(
    context: CallContext,
    email: EmailAddress,
    passwordHash: string,
    now: Temporal.Instant,
    noticeHours: number,
  ): Promise<Result<void, 'email-taken' | 'invalid'>> {
    const { market } = context;
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<void, 'email-taken' | 'invalid'>> => {
        const existing = await this.deps.accounts.findByEmail(market, 'customer', email.normalized);
        if (existing === null) {
          const account = Account.registerCustomer({
            id: this.deps.ids.next<'Account'>(),
            marketId: market.marketId,
            email,
            passwordHash,
            now,
          });
          const added = await this.deps.accounts.add(market, account);
          if (!added.ok) {
            return err(added.error.code === 'account.email-taken' ? 'email-taken' : 'invalid');
          }
          await this.deps.outbox.append(context, account.pendingEvents);
          return ok(undefined);
        }
        existing.signUpAgain({ passwordHash, now, noticeHours });
        await this.deps.accounts.save(market, existing);
        const events = existing.pendingEvents;
        if (events.length > 0) await this.deps.outbox.append(context, events);
        return ok(undefined);
      },
      { isolation: 'serializable' },
    );
  }
}
