import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import type { ProductRepository } from '../ports/product.repository';
import { adminOf, productIdOf } from '../products/product-lifecycle';

export interface PlatformProductDiscardInput {
  readonly productId: unknown;
}

export interface PlatformProductDiscardOutput {
  readonly productId: string;
}

export type PlatformProductDiscardFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'product.not-a-draft' }
  | { readonly code: 'conflict.stale' };

export interface PlatformProductDiscardDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `platform-product.discard` (catalog design 4.1, `draft` to `discarded`): an admin drops a
 * PLATFORM product that was never submitted. Rule: the key `catalog.platform-product.edit` (the
 * key of the other write routes of the form) and the admin population. A SELLER product, a
 * missing one and one that is already discarded all answer the same `product.not-found`, so the
 * route does not tell an admin which ids belong to sellers. The row stays; the aggregate retires
 * every live variant and announces each (one event per variant), saved in one unit.
 */
export class PlatformProductDiscard extends UseCase<
  PlatformProductDiscardInput,
  PlatformProductDiscardOutput,
  PlatformProductDiscardFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-discard',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductDiscardDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductDiscardInput,
  ): Promise<Result<PlatformProductDiscardOutput, PlatformProductDiscardFailure>> {
    if (adminOf(context) === null) return err({ code: 'access.denied' });
    const productId = productIdOf(input.productId);
    if (productId === null) return err({ code: 'product.not-found' });
    const { market } = context;
    const { unitOfWork, products, outbox, clock } = this.deps;
    try {
      return await unitOfWork.run<PlatformProductDiscardOutput, PlatformProductDiscardFailure>(
        market,
        async () => {
          const product = await products.findById(market, productId);
          if (
            product === null ||
            product.state.scope !== 'PLATFORM' ||
            product.state.status === 'discarded'
          ) {
            return err({ code: 'product.not-found' } as const);
          }
          const discarded = product.discard(clock.now());
          if (!discarded.ok) return err({ code: 'product.not-a-draft' } as const);
          await products.save(market, product);
          await outbox.append(context, product.pendingEvents);
          return ok({ productId });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
