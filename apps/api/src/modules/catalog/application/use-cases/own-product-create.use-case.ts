import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { Product, type ProductRefusal } from '../../domain/product';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductTypeLookup } from '../ports/product-type-lookup';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';

/** The request as the route passes it: the type code only. */
export interface OwnProductCreateInput {
  readonly typeCode: string;
}

export interface OwnProductCreateOutput {
  readonly productId: Id<'Product'>;
  readonly productCode: string;
  /** A Simple product's one variant; empty for a Configurable one. */
  readonly variantIds: readonly Id<'Variant'>[];
}

export type OwnProductCreateFailure =
  | ProductRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'setting.product-creation-off' }
  | { readonly code: 'product.type-not-offered' }
  | { readonly code: 'product.type-unknown' }
  | { readonly code: 'type.not-allowed' }
  | { readonly code: 'product.family-unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnProductCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly attributes: AttributeRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  readonly policy: CatalogMarketPolicy;
  readonly productTypes: ProductTypeLookup;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * `own-product.create` (catalog design 4.2 first row; OFR-01): a seller creates a draft SELLER
 * product. Rule: the key `catalog.own-product.edit` and the seller population. The request names
 * the type only; scope, owner, Market, status, family and product code never come from it: the
 * owner is the actor's seller, the family is the Market's `catalog.defaultFamily`, the code is
 * minted from the Market's sequence.
 *
 * Guards, in order: the seller may sell (`seller.not-eligible`); the Market lets sellers create
 * products (`setting.product-creation-off`; a read fault is `access.unavailable`); the type is
 * well formed, is in the Market's list and registered; the type is one the seller may sell
 * (SEL-12, `type.not-allowed`; an error from the reader is `access.unavailable`, ADR-0031); the
 * account's save budget is spent (shared with draft saves, so a loop of creates is bounded). Then
 * one unit writes the product and its events.
 */
export class OwnProductCreate extends UseCase<
  OwnProductCreateInput,
  OwnProductCreateOutput,
  OwnProductCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-create',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnProductCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductCreateInput,
  ): Promise<Result<OwnProductCreateOutput, OwnProductCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.own-product-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: OwnProductCreateInput,
  ): Promise<Result<OwnProductCreateOutput, OwnProductCreateFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    const { deps } = this;

    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    let offered: readonly string[];
    let familyCode: string;
    try {
      if (!(await deps.policy.sellerCanCreateProduct(market))) {
        return err({ code: 'setting.product-creation-off' });
      }
      offered = deps.policy.productTypes(market);
      familyCode = deps.policy.defaultFamily(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (typeof input !== 'object' || input === null || typeof input.typeCode !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'typeCode', code: 'type' }] });
    }
    const { typeCode } = input;
    if (!offered.includes(typeCode)) return err({ code: 'product.type-not-offered' });
    const handler = deps.productTypes(typeCode);
    if (handler === undefined) return err({ code: 'product.type-unknown' });
    const allowed = await deps.allowedTypes.allowedFor(context, sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    if (allowed !== 'all' && !allowed.has(typeCode)) return err({ code: 'type.not-allowed' });

    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    return deps.unitOfWork.run<OwnProductCreateOutput, OwnProductCreateFailure>(
      market,
      async () => {
        if ((await deps.attributes.loadSchema(market, familyCode)) === null) {
          return err({ code: 'product.family-unavailable' } as const);
        }
        const product = Product.create({
          id: deps.ids.next<'Product'>(),
          marketId: market.marketId,
          scope: 'SELLER',
          sellerId,
          handler,
          familyCode,
          productCode: await deps.products.nextProductCode(market),
          variantId: handler.variantModel === 'single' ? deps.ids.next<'Variant'>() : null,
          now: deps.clock.now(),
        });
        if (!product.ok) return err(product.error);
        await deps.products.add(market, product.value);
        await deps.outbox.append(context, product.value.pendingEvents);
        return ok({
          productId: product.value.state.id,
          productCode: product.value.state.productCode,
          variantIds: product.value.state.variants.map((variant) => variant.id),
        });
      },
    );
  }
}
