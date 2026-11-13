import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { VariantRequestedAudit } from '../../domain/audit';
import { optionKeyOf } from '../../domain/revision-freeze';
import {
  MAX_OPEN_VARIANT_REQUESTS_PER_SELLER,
  MAX_VARIANT_REQUESTS_PER_DAY,
  VariantRequest,
  areRequestOptionValues,
  type VariantRequestRefusal,
} from '../../domain/variant-request';
import { sellerOf } from '../own-reads/own-reads.shared';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { VariantRequestStore } from '../ports/variant-request.store';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import {
  loadProductVariantFacts,
  type ProductFactsFailure,
} from '../variant-requests/variant-requests';

export interface OwnVariantRequestCreateInput {
  readonly offerId: unknown;
  /** Variant attribute code to option code. */
  readonly optionValues: unknown;
}

export interface OwnVariantRequestCreateOutput {
  readonly id: string;
  readonly status: 'open';
  readonly version: number;
}

export type OwnVariantRequestCreateFailure =
  | VariantRequestRefusal
  | ProductFactsFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-eligible' }
  /** Unknown, another seller's, another Market's and deleted Offers alike. */
  | { readonly code: 'offer.not-found' }
  /** The values do not name an active option on each axis of the product. */
  | { readonly code: 'variant-request.option-unknown' }
  /** The product already has this variant: the seller should switch it on. */
  | { readonly code: 'variant-request.variant-exists' }
  | { readonly code: 'variant-request.already-open' }
  | { readonly code: 'variant-request.limit-reached'; readonly max: number }
  | { readonly code: 'variant-request.daily-limit'; readonly max: number }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnVariantRequestCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly revisions: ProductRevisionRepository;
  readonly attributes: AttributeRepository;
  readonly variantRequests: VariantRequestStore;
  readonly eligibility: SellerEligibilityReader;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * `own-variant-request.create` (variants V7): a seller asks for a variant (a size) that a
 * PLATFORM product they sell does not have. Rule: the key `catalog.own-product.edit`, the seller
 * population and a seller who may sell. The request names the Offer and the option values; the
 * seller, product and Market come from stored state. An Offer that is unknown, another seller's or
 * another Market's, or deleted, answers one byte-identical `offer.not-found`. The values must name
 * an active option on each axis of the product and no more; a combination the product already
 * has is refused (`variant-request.variant-exists`). One open request per Offer and combination,
 * at most {@link MAX_OPEN_VARIANT_REQUESTS_PER_SELLER} open and
 * {@link MAX_VARIANT_REQUESTS_PER_DAY} in 24 hours per seller. Nothing the seller typed is stored:
 * the values are option codes. An admin decides it; one audit row, with ids only.
 */
export class OwnVariantRequestCreate extends UseCase<
  OwnVariantRequestCreateInput,
  OwnVariantRequestCreateOutput,
  OwnVariantRequestCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-variant-request-create',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnVariantRequestCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnVariantRequestCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnVariantRequestCreateInput,
  ): Promise<Result<OwnVariantRequestCreateOutput, OwnVariantRequestCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.own-variant-request-create',
      code: result.ok ? 'opened' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: OwnVariantRequestCreateInput,
  ): Promise<Result<OwnVariantRequestCreateOutput, OwnVariantRequestCreateFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (!(await this.deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const fail = (path: string, code: string): Result<never, OwnVariantRequestCreateFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const offerId = typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
    if (offerId === null || !offerId.ok) return fail('offerId', 'format');
    if (!areRequestOptionValues(input.optionValues)) return fail('optionValues', 'shape');
    const optionValues = input.optionValues;
    const { market } = context;
    return this.deps.unitOfWork.run<OwnVariantRequestCreateOutput, OwnVariantRequestCreateFailure>(
      market,
      async () => {
        const { offers, variantRequests: requests, attributes } = this.deps;
        const offer = await offers.findById(market, offerId.value);
        if (
          offer === null ||
          offer.state.sellerId !== sellerId ||
          offer.state.status === 'deleted'
        ) {
          return err({ code: 'offer.not-found' } as const);
        }
        // The two caps below are soft: they are counted, then the row is inserted, under READ
        // COMMITTED, so parallel requests of one seller can pass a cap by a few. The admin queue
        // and the unique index on open combinations bound the damage (same as value suggestions).
        const facts = await loadProductVariantFacts(this.deps, market, offer.state.productId);
        if (!facts.ok) return err(facts.error);
        // Exactly the axes of the product, each an active option of its attribute.
        const given = Object.keys(optionValues).sort();
        if (
          given.length !== facts.value.axes.length ||
          given.some((axis, i) => axis !== facts.value.axes[i])
        ) {
          return err({ code: 'variant-request.option-unknown' } as const);
        }
        const schema = await attributes.loadSchema(market, facts.value.familyCode);
        if (schema === null) return err({ code: 'variant-request.option-unknown' } as const);
        for (const axis of given) {
          const field = schema.fields.find((candidate) => candidate.code === axis);
          const options = field?.bounds.options ?? [];
          if (
            field === undefined ||
            !field.isVariantOption ||
            !options.some((option) => option.code === optionValues[axis])
          ) {
            return err({ code: 'variant-request.option-unknown' } as const);
          }
        }
        if (facts.value.liveKeys.has(optionKeyOf(optionValues))) {
          return err({ code: 'variant-request.variant-exists' } as const);
        }
        if (
          (await requests.openCountOfSeller(market, sellerId)) >=
          MAX_OPEN_VARIANT_REQUESTS_PER_SELLER
        ) {
          return err({
            code: 'variant-request.limit-reached',
            max: MAX_OPEN_VARIANT_REQUESTS_PER_SELLER,
          } as const);
        }
        const now = this.deps.clock.now();
        const dayAgo = now.subtract(Temporal.Duration.from({ hours: 24 }));
        if ((await requests.madeSince(market, sellerId, dayAgo)) >= MAX_VARIANT_REQUESTS_PER_DAY) {
          return err({
            code: 'variant-request.daily-limit',
            max: MAX_VARIANT_REQUESTS_PER_DAY,
          } as const);
        }
        const opened = VariantRequest.open({
          id: this.deps.ids.next<'VariantRequest'>(),
          marketId: market.marketId,
          sellerId,
          offerId: offer.state.id,
          productId: offer.state.productId,
          optionValues,
          now,
        });
        if (!opened.ok) return err(opened.error);
        const refused = await requests.add(market, opened.value);
        if (refused !== null) return err({ code: refused } as const);
        await this.deps.audit.record(
          context,
          VariantRequestedAudit.entry(opened.value.state.id, {
            after: { offerId: offer.state.id, productId: offer.state.productId },
          }),
        );
        return ok({
          id: opened.value.state.id,
          status: 'open',
          version: opened.value.state.version,
        });
      },
    );
  }
}
