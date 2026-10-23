import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  parseStorefrontPalette,
  parseStorefrontTextSize,
} from '../../domain/storefront-appearance';
import type { AccountRepository } from '../ports/account.repository';
import type { FieldProblem } from './register-customer.use-case';

export interface ChangeStorefrontAppearanceInput {
  /** A palette from `STOREFRONT_PALETTES`, or null for no choice. */
  readonly palette: string | null;
  /** A text size from `STOREFRONT_TEXT_SIZES`, or null for no choice. */
  readonly textSize: string | null;
}

export interface ChangeStorefrontAppearanceOutput {
  readonly code: 'storefront-appearance-changed';
  /** False when the values were already the ones given: nothing was written. */
  readonly changed: boolean;
}

export type ChangeStorefrontAppearanceFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

export interface ChangeStorefrontAppearanceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
}

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * A signed-in customer keeps the own storefront look (palette and text size) on the account, so
 * it follows them to another browser (buyer account Settings, john 19 Oct). Rule
 * `own-resources`; the account is the actor's: the input names none. Admin and seller-side
 * accounts are refused (they have panel preferences). No code is asked for: a look gives access
 * to nothing. A concurrent change of the same account answers `access.unavailable` and the
 * holder repeats it.
 */
export class ChangeStorefrontAppearance extends UseCase<
  ChangeStorefrontAppearanceInput,
  ChangeStorefrontAppearanceOutput,
  ChangeStorefrontAppearanceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.change-storefront-appearance',
    rule: { kind: 'own-resources' },
    // Customers only: a seller-side actor is refused whatever its seller's state.
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeStorefrontAppearanceDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ChangeStorefrontAppearanceInput,
  ): Promise<Result<ChangeStorefrontAppearanceOutput, ChangeStorefrontAppearanceFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    if (actor.population !== 'customer') return err({ code: 'access.denied' });
    const palette = parseStorefrontPalette(input.palette);
    const textSize = parseStorefrontTextSize(input.textSize);
    const fields: FieldProblem[] = [];
    if (!palette.ok) fields.push({ path: 'palette', code: 'invalid' });
    if (!textSize.ok) fields.push({ path: 'textSize', code: 'invalid' });
    if (!palette.ok || !textSize.ok) return err({ code: 'validation.failed', fields });
    try {
      return await this.deps.unitOfWork.run(
        market,
        async (): Promise<
          Result<ChangeStorefrontAppearanceOutput, ChangeStorefrontAppearanceFailure>
        > => {
          const account = await this.deps.accounts.findById(market, actor.accountId);
          if (account === null || account.state.population !== 'customer') {
            return err({ code: 'access.denied' });
          }
          const set = account.setAppearance({ palette: palette.value, textSize: textSize.value });
          if (!set.ok) return err({ code: 'access.denied' });
          if (set.value) await this.deps.accounts.save(market, account);
          return ok({ code: 'storefront-appearance-changed', changed: set.value });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err(UNAVAILABLE);
      throw error;
    }
  }
}
