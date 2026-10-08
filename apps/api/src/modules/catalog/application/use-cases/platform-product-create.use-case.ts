import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import { Product, type ProductRefusal } from '../../domain/product';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductTypeLookup } from '../ports/product-type-lookup';

/** The request as the route will pass it: the type code only. */
export interface PlatformProductCreateInput {
  readonly typeCode: string;
}

export interface PlatformProductCreateOutput {
  readonly productId: Id<'Product'>;
  readonly productCode: string;
  /** A Simple product's one variant; empty for a Configurable one. */
  readonly variantIds: readonly Id<'Variant'>[];
}

export type PlatformProductCreateFailure =
  | ProductRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.type-not-offered' }
  | { readonly code: 'product.type-unknown' }
  | { readonly code: 'product.family-unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface PlatformProductCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly attributes: AttributeRepository;
  readonly policy: CatalogMarketPolicy;
  readonly productTypes: ProductTypeLookup;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * `platform-product.create` (catalog design 4.2 first row; CAT-10, CAT-41): an admin creates a
 * PLATFORM draft product. Rule: the key `catalog.platform-product.edit` and the admin population.
 * The request names the type only. Scope, owner, Market, status, family and product code never
 * come from the request: the scope is PLATFORM, the family is the Market's `catalog.defaultFamily`
 * (it must be a seeded family, else `product.family-unavailable`), the type must be in the Market's
 * `catalog.productTypes` and registered (else `product.type-not-offered` / `product.type-unknown`),
 * and the product code is minted from the Market's sequence. A Simple product gets its one variant
 * at once. The product, its events and the code sequence step are written in one unit.
 */
export class PlatformProductCreate extends UseCase<
  PlatformProductCreateInput,
  PlatformProductCreateOutput,
  PlatformProductCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-create',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  readonly #logger = new Logger('PlatformProductCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductCreateInput,
  ): Promise<Result<PlatformProductCreateOutput, PlatformProductCreateFailure>> {
    const outcome = await this.#create(context, input);
    // One exit logs every outcome with fixed fields only: never the input, never an error message.
    this.#logger.log({
      msg: 'catalog.platform-product-create',
      code: outcome.result.ok ? 'created' : outcome.result.error.code,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return outcome.result;
  }

  async #create(
    context: CallContext,
    input: PlatformProductCreateInput,
  ): Promise<{
    readonly result: Result<PlatformProductCreateOutput, PlatformProductCreateFailure>;
    readonly reason?: string;
  }> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return { result: err({ code: 'access.denied' }) };
    }
    if (typeof input !== 'object' || input === null || typeof input.typeCode !== 'string') {
      return {
        result: err({ code: 'validation.failed', fields: [{ path: 'typeCode', code: 'type' }] }),
      };
    }
    const { typeCode } = input;
    const { policy, attributes, products, outbox, clock, ids } = this.deps;

    let offered: readonly string[];
    let familyCode: string;
    try {
      offered = policy.productTypes(market);
      familyCode = policy.defaultFamily(market);
    } catch (error) {
      return {
        result: err({ code: 'access.unavailable' }),
        reason: error instanceof Error ? error.name : 'unknown',
      };
    }
    if (!offered.includes(typeCode)) return { result: err({ code: 'product.type-not-offered' }) };
    const handler = this.deps.productTypes(typeCode);
    if (handler === undefined) return { result: err({ code: 'product.type-unknown' }) };

    const created = await this.deps.unitOfWork.run<
      PlatformProductCreateOutput,
      PlatformProductCreateFailure
    >(market, async () => {
      if ((await attributes.loadSchema(market, familyCode)) === null) {
        return err({ code: 'product.family-unavailable' } as const);
      }
      const now = clock.now();
      const product = Product.create({
        id: ids.next<'Product'>(),
        marketId: market.marketId,
        scope: 'PLATFORM',
        sellerId: null,
        handler,
        familyCode,
        productCode: await products.nextProductCode(market),
        variantId: handler.variantModel === 'single' ? ids.next<'Variant'>() : null,
        now,
      });
      if (!product.ok) return err(product.error);
      await products.add(market, product.value);
      await outbox.append(context, product.value.pendingEvents);
      return ok({
        productId: product.value.state.id,
        productCode: product.value.state.productCode,
        variantIds: product.value.state.variants.map((variant) => variant.id),
      });
    });
    return { result: created };
  }
}
