import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { Account } from '../../domain/account';
import { parseEmailAddress } from '../../domain/email-address';
import { checkNewPassword, type PasswordRejected } from '../../domain/password-policy';
import type { AccountRepository } from '../ports/account.repository';
import type { CommonPasswordList } from '../ports/common-password-list';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';

export interface RegisterCustomerInput {
  readonly email: string;
  readonly password: string;
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
 * the password is hashed **before any read**, and then one serializable read-write unit runs
 * (HF8: it inserts into `accounts`), so every branch costs one hash and one write unit:
 *
 * - a new address: an active, unverified customer account without a display name, its
 *   credential and its data key; `identity.customer-account-registered.v1`;
 * - an unverified account: the password is replaced and the purge anchor restarts;
 *   `identity.sign-up-repeated.v1` (`unverified-replaced`);
 * - a verified account: nothing changes but the notice instant, at most once per the Market's
 *   interval; `identity.sign-up-repeated.v1` (`verified-notice`). Within the interval the unit
 *   reads and commits without a write (the mail counter of 6.8 arrives with slice 2).
 *
 * Every branch answers `sign-up.accepted`. Two concurrent sign-ups of the same new address end
 * as if they had run one after the other: PostgreSQL usually refuses the second insert with a
 * serialisation failure, the unit runs `work` again (P 3.1 row 7) and it takes the repeat
 * branch (the later password stands); if the unique key refuses it instead, it answers the
 * same and changes nothing (the earlier password stands). The hash is never recomputed on a
 * retry: it was made before the unit.
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
    const stored = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<void, 'email-taken' | 'invalid'>> => {
        const existing = await this.deps.accounts.findByEmail(
          market,
          'customer',
          email.value.normalized,
        );
        if (existing === null) {
          const account = Account.registerCustomer({
            id: this.deps.ids.next<'Account'>(),
            marketId: market.marketId,
            email: email.value,
            passwordHash: hashed.value,
            now,
          });
          const added = await this.deps.accounts.add(market, account);
          if (!added.ok) {
            return err(added.error.code === 'account.email-taken' ? 'email-taken' : 'invalid');
          }
          await this.deps.outbox.append(context, account.pendingEvents);
          return ok(undefined);
        }
        existing.signUpAgain({ passwordHash: hashed.value, now, noticeHours });
        await this.deps.accounts.save(market, existing);
        const events = existing.pendingEvents;
        if (events.length > 0) await this.deps.outbox.append(context, events);
        return ok(undefined);
      },
      { isolation: 'serializable' },
    );
    if (!stored.ok && stored.error === 'invalid') {
      return err({ code: 'validation.failed', fields: [] });
    }
    return ok({ code: 'sign-up.accepted' });
  }
}
