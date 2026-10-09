import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { Offer, type OfferRefusal } from '../../domain/offer';
import { Product, type ProductRefusal } from '../../domain/product';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import { parseOfferContent } from '../offer-content';
import type { OfferRepository } from '../ports/offer.repository';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductTypeLookup } from '../ports/product-type-lookup';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';

/**
 * The request as the route passes it: the type code and the Offer form (design 4.4: an own
 * product is created with its Offer, "same form"). A closed set: no handling, attestation or tag.
 */
export interface OwnProductCreateInput {
  readonly typeCode: string;
  readonly sellerSku: string;
  readonly conditionCode: string;
  /** Locale to text; empty is allowed. */
  readonly description: unknown;
}

export interface OwnProductCreateOutput {
  readonly offerId: Id<'Offer'>;
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
  | { readonly code: 'offer.sku-taken' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnProductCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly offers: OfferRepository;
  readonly check: CheckClaimText;
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
 * The Offer of the product is created with it in the same unit (design 4.4, "same form"): SKU,
 * condition and description, parsed like the Offer routes; handling, attestation and tags are never
 * inputs (B1). The description passes the claim-text control (a hit refuses the whole create).
 * A taken SKU is `offer.sku-taken` and nothing is stored.
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
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return err({ code: 'validation.failed', fields: [{ path: 'body', code: 'type' }] });
    }
    for (const key of Object.keys(input)) {
      if (!(INPUT_KEYS as readonly string[]).includes(key)) {
        return err({ code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] });
      }
    }
    if (typeof input.typeCode !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'typeCode', code: 'type' }] });
    }
    const { typeCode } = input;
    if (!offered.includes(typeCode)) return err({ code: 'product.type-not-offered' });
    const handler = deps.productTypes(typeCode);
    if (handler === undefined) return err({ code: 'product.type-unknown' });
    const content = parseOfferContent(deps.policy, market, input);
    if (!content.ok) return content;
    const { sellerSku, conditionCode, description } = content.value;
    const allowed = await deps.allowedTypes.allowedFor(context, sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    if (allowed !== 'all' && !allowed.has(typeCode)) return err({ code: 'type.not-allowed' });

    // Spent before the claim matcher, so a loop of creates is bounded.
    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    // The claim-text control runs outside any unit (it opens its own); a hit refuses the create.
    const texts = Object.entries(description).filter(([, text]) => text !== '');
    if (texts.length > 0) {
      const checked = await deps.check.execute(
        context,
        texts.map(([locale, text]) => ({ field: 'offer.description', ref: null, locale, text })),
      );
      if (!checked.ok) {
        return err(
          checked.error.code === 'validation.failed'
            ? { code: 'validation.failed', fields: [{ path: 'description', code: 'invalid' }] }
            : checked.error.code === 'access.denied'
              ? { code: 'access.denied' }
              : { code: 'access.unavailable' },
        );
      }
      const refused = checked.value.flatMap((verdict) => refusalOf(verdict) ?? []);
      if (refused.length > 0) return err({ code: 'claim-text.refused', fields: refused });
    }

    return deps.unitOfWork.run<OwnProductCreateOutput, OwnProductCreateFailure>(
      market,
      async () => {
        if ((await deps.attributes.loadSchema(market, familyCode)) === null) {
          return err({ code: 'product.family-unavailable' } as const);
        }
        const now = deps.clock.now();
        const product = Product.create({
          id: deps.ids.next<'Product'>(),
          marketId: market.marketId,
          scope: 'SELLER',
          sellerId,
          handler,
          familyCode,
          productCode: await deps.products.nextProductCode(market),
          variantId: handler.variantModel === 'single' ? deps.ids.next<'Variant'>() : null,
          now,
        });
        if (!product.ok) return err(product.error);
        const offer = Offer.create({
          id: deps.ids.next<'Offer'>(),
          marketId: market.marketId,
          sellerId,
          productId: product.value.state.id,
          sellerSku,
          conditionCode,
          description,
          now,
        });
        if (!offer.ok) return err(validationOf(offer.error));
        await deps.products.add(market, product.value);
        // The SKU unique decides a race: its violation ends the unit with an error, so the
        // product above is not kept either.
        const refusal = await deps.offers.add(market, offer.value, {
          kind: 'seller',
          accountId: actor.accountId,
        });
        if (refusal === 'offer.sku-taken') return err({ code: 'offer.sku-taken' } as const);
        // A new product has no Offer yet, so the one-per-product refusal cannot come back.
        if (refusal !== null) return err({ code: 'access.unavailable' } as const);
        await deps.outbox.append(context, [
          ...product.value.pendingEvents,
          ...offer.value.pendingEvents,
        ]);
        return ok({
          offerId: offer.value.state.id,
          productId: product.value.state.id,
          productCode: product.value.state.productCode,
          variantIds: product.value.state.variants.map((variant) => variant.id),
        });
      },
    );
  }
}

const INPUT_KEYS = ['typeCode', 'sellerSku', 'conditionCode', 'description'] as const;

function validationOf(refusal: OfferRefusal): OwnProductCreateFailure {
  switch (refusal.code) {
    case 'offer.sku-invalid':
      return { code: 'validation.failed', fields: [{ path: 'sellerSku', code: 'format' }] };
    case 'offer.condition-invalid':
      return { code: 'validation.failed', fields: [{ path: 'conditionCode', code: 'format' }] };
    case 'offer.description-invalid':
      return { code: 'validation.failed', fields: [{ path: 'description', code: 'format' }] };
    case 'offer.not-editable':
      return { code: 'validation.failed', fields: [{ path: 'body', code: 'state' }] };
  }
}
