import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseCustomerLanguage } from '../../domain/customer-language';
import type { AccountRepository } from '../ports/account.repository';
import type { FieldProblem } from './register-customer.use-case';

export interface ChangeCustomerLanguageInput {
  /** A language from `CUSTOMER_LANGUAGES`, or null for no choice (English). */
  readonly locale: string | null;
}

export interface ChangeCustomerLanguageOutput {
  readonly code: 'customer-language-changed';
  /** False when the values were already the ones given: nothing was written. */
  readonly changed: boolean;
}

export type ChangeCustomerLanguageFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

export interface ChangeCustomerLanguageDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
}

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * A signed-in customer keeps the own language on the account (buyer profile; the language is
 * chosen only there, no switcher, john 25 Oct). Keeping one does not publish it: the storefront
 * serves only the languages the Market has published. Rule
 * `own-resources`; the account is the actor's: the input names none. Admin and seller-side
 * accounts are refused (they have panel preferences). No code is asked for: a language gives access
 * to nothing. A concurrent change of the same account answers `access.unavailable` and the
 * holder repeats it.
 */
export class ChangeCustomerLanguage extends UseCase<
  ChangeCustomerLanguageInput,
  ChangeCustomerLanguageOutput,
  ChangeCustomerLanguageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.change-customer-language',
    rule: { kind: 'own-resources' },
    // Customers only: a seller-side actor is refused whatever its seller's state.
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeCustomerLanguageDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ChangeCustomerLanguageInput,
  ): Promise<Result<ChangeCustomerLanguageOutput, ChangeCustomerLanguageFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    if (actor.population !== 'customer') return err({ code: 'access.denied' });
    const locale = parseCustomerLanguage(input.locale);
    if (!locale.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'locale', code: 'invalid' }] });
    }
    try {
      return await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<ChangeCustomerLanguageOutput, ChangeCustomerLanguageFailure>> => {
          const account = await this.deps.accounts.findById(market, actor.accountId);
          if (account === null || account.state.population !== 'customer') {
            return err({ code: 'access.denied' });
          }
          const set = account.setLanguage(locale.value);
          if (!set.ok) return err({ code: 'access.denied' });
          if (set.value) await this.deps.accounts.save(market, account);
          return ok({ code: 'customer-language-changed', changed: set.value });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err(UNAVAILABLE);
      throw error;
    }
  }
}
