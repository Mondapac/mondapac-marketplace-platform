import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_FACADE_BATCH } from '../../contracts/catalog.facade';
import type { ProductLinkFacts, ProductLinkingReader } from '../ports/product-linking.reader';
import type { OfferSellUnitsFailure } from '../offers/offer-sell-units-request';

export interface ProductsForLinkingInput {
  readonly productIds: readonly string[];
  readonly sellerId: string | null;
}

export interface ProductsForLinkingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly productLinkingReader: ProductLinkingReader;
}

/**
 * `productsForLinking` (blog package 1): for each requested product that is published, whether it
 * is on sale now and whether the given seller sells it, at most 200 products, refused whole above.
 * Rule `anonymous`: ids and two flags only, nothing a buyer could not see on the site. An unknown
 * product, another Market's and a product that is not published are absent from the map. The
 * request is checked whole before any read.
 */
export class ProductsForLinkingQuery extends UseCase<
  ProductsForLinkingInput,
  ReadonlyMap<Id<'Product'>, ProductLinkFacts>,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.products-for-linking',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductsForLinkingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductsForLinkingInput,
  ): Promise<Result<ReadonlyMap<Id<'Product'>, ProductLinkFacts>, OfferSellUnitsFailure>> {
    if (!Array.isArray(input.productIds)) {
      return err({ code: 'validation.failed', fields: [{ path: 'productIds', code: 'type' }] });
    }
    if (input.productIds.length > MAX_FACADE_BATCH) return err({ code: 'batch.too-large' });
    const requested = new Set<Id<'Product'>>();
    for (const value of input.productIds as readonly unknown[]) {
      const id = typeof value === 'string' ? parseId<'Product'>(value) : null;
      if (id === null || !id.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'productIds', code: 'format' }] });
      }
      requested.add(id.value);
    }
    let sellerId: Id<'Seller'> | null = null;
    if (input.sellerId !== null && input.sellerId !== undefined) {
      const parsed = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
      if (parsed === null || !parsed.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
      }
      sellerId = parsed.value;
    }
    if (requested.size === 0) return ok(new Map());
    return this.deps.unitOfWork.run<
      ReadonlyMap<Id<'Product'>, ProductLinkFacts>,
      OfferSellUnitsFailure
    >(
      context.market,
      async () =>
        ok(await this.deps.productLinkingReader.read(context.market, [...requested], sellerId)),
      { readOnly: true },
    );
  }
}
