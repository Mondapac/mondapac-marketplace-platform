import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { Offer, type OfferRefusal } from '../../domain/offer';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import { parseOfferContent } from '../offer-content';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';

/** The request as the route will pass it. A closed shape: no other key is accepted (B1, L8). */
export interface OwnOfferCreateOnPlatformProductInput {
  readonly productId: string;
  readonly sellerSku: string;
  readonly conditionCode: string;
  /** Locale to text; empty is allowed. */
  readonly description: unknown;
}

export interface OwnOfferCreateOnPlatformProductOutput {
  readonly offerId: Id<'Offer'>;
}

export type OwnOfferCreateOnPlatformProductFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'type.not-allowed' }
  | { readonly code: 'setting.sell-from-catalogue-off' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'offer.exists-for-product' }
  | { readonly code: 'offer.sku-taken' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferCreateOnPlatformProductDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly offers: OfferRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
  readonly check: CheckClaimText;
  /** Spends the account's save budget (design 8.4: creating an Offer shares the draft-save limits). */
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  readonly policy: CatalogMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const INPUT_KEYS = ['productId', 'sellerSku', 'conditionCode', 'description'] as const;

/**
 * `own-offer.create-on-platform-product` (catalog design 4.4 first row, 8.2; OFR-02, OFR-03): a
 * seller creates a draft Offer on a published PLATFORM product. Rule: the key
 * `catalog.own-product.edit` and the seller population. The seller comes from the actor, never
 * from the request; the input is closed and carries no handling, attestation or tag (B1).
 *
 * Guards, in order: the seller may sell (`sellingEligibility`); the Market allows selling from the
 * catalogue; the input is well formed (closed shape, the condition is one of the Market's, the
 * description fits the Market's locales and size bounds); the account's save budget is spent
 * (`request.throttled`; shared with draft saves, so a loop of creates is bounded before any read
 * or matcher call); the product is PLATFORM, published and not retired, else a byte-identical
 * `product.not-found` (M3); its type is one the seller may sell (SEL-12; an error refuses); the
 * description passes the claim-text control (a hit refuses the whole create, nothing is stored).
 * In one unit the Offer and its first history row are stored with `offer-created`. Both uniques
 * end the unit with an error, so nothing of it commits.
 */
export class OwnOfferCreateOnPlatformProduct extends UseCase<
  OwnOfferCreateOnPlatformProductInput,
  OwnOfferCreateOnPlatformProductOutput,
  OwnOfferCreateOnPlatformProductFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-create-on-platform-product',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    // A seller who is not approved cannot create Offers.
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferCreateOnPlatformProduct');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferCreateOnPlatformProductDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferCreateOnPlatformProductInput,
  ): Promise<
    Result<OwnOfferCreateOnPlatformProductOutput, OwnOfferCreateOnPlatformProductFailure>
  > {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-create-on-platform-product',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: OwnOfferCreateOnPlatformProductInput,
  ): Promise<
    Result<OwnOfferCreateOnPlatformProductOutput, OwnOfferCreateOnPlatformProductFailure>
  > {
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
    try {
      if (!(await deps.policy.sellFromCatalogue(market))) {
        return err({ code: 'setting.sell-from-catalogue-off' });
      }
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const parsed = this.#parse(market, input);
    if (!parsed.ok) return parsed;
    const { productId, sellerSku, conditionCode, description } = parsed.value;

    // Spent before any read or the claim matcher, so a loop of creates is bounded (Hassan 7a-2 M-1).
    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    // Read-only first: the product guards and the SEL-12 answer; the write unit repeats the
    // product read so a retire between the two cannot slip through.
    const guard = await deps.unitOfWork.run(
      market,
      async () => ok(await this.#productTypeOf(market, productId)),
      { readOnly: true },
    );
    if (!guard.ok) return err({ code: 'access.unavailable' });
    if (guard.value === null) return err({ code: 'product.not-found' });
    const allowed = await deps.allowedTypes.allowedFor(context, sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    if (allowed !== 'all' && !allowed.has(guard.value)) return err({ code: 'type.not-allowed' });

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

    return deps.unitOfWork.run<
      OwnOfferCreateOnPlatformProductOutput,
      OwnOfferCreateOnPlatformProductFailure
    >(market, async () => {
      if ((await this.#productTypeOf(market, productId)) === null) {
        return err({ code: 'product.not-found' } as const);
      }
      const offer = Offer.create({
        id: deps.ids.next<'Offer'>(),
        marketId: market.marketId,
        sellerId,
        productId,
        sellerSku,
        conditionCode,
        description,
        now: deps.clock.now(),
      });
      if (!offer.ok) return err(validationOf(offer.error));
      const refusal = await deps.offers.add(market, offer.value, {
        kind: 'seller',
        accountId: actor.accountId,
      });
      if (refusal !== null) return err({ code: refusal } as const);
      await deps.outbox.append(context, offer.value.pendingEvents);
      return ok({ offerId: offer.value.state.id });
    });
  }

  /** The product's type code when it is a published, non-retired PLATFORM product, else null. */
  async #productTypeOf(market: MarketContext, productId: Id<'Product'>): Promise<string | null> {
    const product = await this.deps.products.findById(market, productId);
    if (product === null) return null;
    const { scope, status, typeCode } = product.state;
    return scope === 'PLATFORM' && status === 'published' ? typeCode : null;
  }

  #parse(
    market: MarketContext,
    input: OwnOfferCreateOnPlatformProductInput,
  ): Result<
    {
      productId: Id<'Product'>;
      sellerSku: string;
      conditionCode: string;
      description: Record<string, string>;
    },
    OwnOfferCreateOnPlatformProductFailure
  > {
    const fail = (path: string, code: string) =>
      err({ code: 'validation.failed', fields: [{ path, code }] } as const);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return fail('body', 'type');
    }
    for (const key of Object.keys(input)) {
      if (!(INPUT_KEYS as readonly string[]).includes(key)) return fail(key, 'unknown');
    }
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return fail('productId', 'format');
    const content = parseOfferContent(this.deps.policy, market, input);
    if (!content.ok) return content;
    return ok({ productId: product.value, ...content.value });
  }
}

function validationOf(
  refusal: OfferRefusal,
): OwnOfferCreateOnPlatformProductFailure & { readonly code: 'validation.failed' } {
  const path =
    refusal.code === 'offer.sku-invalid'
      ? 'sellerSku'
      : refusal.code === 'offer.condition-invalid'
        ? 'conditionCode'
        : 'description';
  return { code: 'validation.failed', fields: [{ path, code: 'format' }] };
}
