import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReadModelDependencies } from '../read-model-dependencies';

export type LastOrderFailure =
  | { readonly code: 'validation.failed' }
  /** The customer has no directory row yet: the answer is not known, never a guess. */
  | { readonly code: 'customers.customer-unknown' };

/**
 * `customers.read-customer-last-order`: when a customer last had an order confirmed (placed and
 * paid), or null when they never did. Rule `system` (promotions asks with the Market's system
 * actor). A customer with no directory row is `customers.customer-unknown`, so the caller fails
 * closed. Ids and one instant: no personal data.
 */
export class ReadCustomerLastOrder extends UseCase<
  { readonly accountId: string },
  { readonly lastOrderAt: Temporal.Instant | null },
  LastOrderFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.read-customer-last-order',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReadModelDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly accountId: string },
  ): Promise<Result<{ readonly lastOrderAt: Temporal.Instant | null }, LastOrderFailure>> {
    const parsed =
      typeof input?.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
    if (parsed === null || !parsed.ok) return Promise.resolve(err({ code: 'validation.failed' }));
    const accountId = parsed.value;
    return this.deps.unitOfWork.run<
      { readonly lastOrderAt: Temporal.Instant | null },
      LastOrderFailure
    >(
      context.market,
      async () => {
        if (!(await this.deps.readModels.hasDirectory(context.market, accountId))) {
          return err({ code: 'customers.customer-unknown' } as const);
        }
        const stats = await this.deps.readModels.findStats(context.market, accountId);
        return ok({ lastOrderAt: stats?.lastOrderAt ?? null });
      },
      { readOnly: true },
    );
  }
}
