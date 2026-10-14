import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';

export interface OwnOfferSubmitInput {
  readonly offerId: string;
}

export interface OwnOfferSubmitOutput {
  /** True when the Offer is published at once; false when it waits for review. */
  readonly published: boolean;
}

export type OwnOfferSubmitFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-submittable' }
  | { readonly code: 'offer.handling-missing' }
  | { readonly code: 'offer.product-not-published' }
  | { readonly code: 'type.not-allowed' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferSubmitDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly products: ProductRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
  readonly check: CheckClaimText;
  readonly policy: CatalogMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `own-offer.submit` (catalog design 4.4; OFR-01): a seller submits a `draft` Offer of their own.
 * Rule: the key `catalog.own-product.edit`, the seller population and a seller who may sell. The
 * request names the Offer only; the seller comes from the actor. Guards, in order: the seller may
 * sell; the Offer exists and is theirs (else a byte-identical `offer.not-found`); the product is
 * published (`offer.product-not-published`) and of a type the seller may sell (SEL-12; an error
 * from the reader is `access.unavailable`, ADR-0031); every description text passes the
 * claim-text control again, since the vocabulary can have grown since the last save. In one unit
 * the Offer is read again, its version must equal the one that was checked (else
 * `conflict.stale`), the Market's `catalog.approval-required` is read, and the Offer waits for
 * review or is published at once. Handling must already be recorded (`offer.handling-missing`):
 * its own command arrives with the next catalog package. Tags join with slice 8.
 */
export class OwnOfferSubmit extends UseCase<
  OwnOfferSubmitInput,
  OwnOfferSubmitOutput,
  OwnOfferSubmitFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-submit',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferSubmit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferSubmitDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferSubmitInput,
  ): Promise<Result<OwnOfferSubmitOutput, OwnOfferSubmitFailure>> {
    const result = await this.#submit(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-submit',
      code: result.ok ? (result.value.published ? 'published' : 'pending') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #submit(
    context: CallContext,
    input: OwnOfferSubmitInput,
  ): Promise<Result<OwnOfferSubmitOutput, OwnOfferSubmitFailure>> {
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
    const offerId =
      typeof input === 'object' && input !== null && typeof input.offerId === 'string'
        ? parseId<'Offer'>(input.offerId)
        : null;
    if (offerId === null || !offerId.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] });
    }

    // Read-only first: ownership, the product's state and the texts to check.
    const guard = await deps.unitOfWork.run(
      market,
      async () => {
        const offer = await deps.offers.findById(market, offerId.value);
        if (
          offer === null ||
          offer.state.sellerId !== sellerId ||
          offer.state.status === 'deleted'
        ) {
          return ok(null);
        }
        const product = await deps.products.findById(market, offer.state.productId);
        return ok({
          description: offer.state.description,
          version: offer.state.version,
          productStatus: product?.state.status ?? null,
          typeCode: product?.state.typeCode ?? null,
        });
      },
      { readOnly: true },
    );
    if (!guard.ok) return err({ code: 'access.unavailable' });
    if (guard.value === null) return err({ code: 'offer.not-found' });
    const { description, version, productStatus, typeCode } = guard.value;
    if (productStatus !== 'published' || typeCode === null) {
      return err({ code: 'offer.product-not-published' });
    }
    const allowed = await deps.allowedTypes.allowedFor(context, sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    if (allowed !== 'all' && !allowed.has(typeCode)) return err({ code: 'type.not-allowed' });

    // Every non-empty text, outside any unit (the control opens its own).
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
      // Anything that is not plainly clean refuses, so an unknown verdict can never pass.
      const refused = checked.value.flatMap((verdict) =>
        verdict.code === 'clean' ? [] : (refusalOf(verdict) ?? []),
      );
      if (checked.value.some((verdict) => verdict.code !== 'clean') && refused.length === 0) {
        return err({ code: 'access.unavailable' });
      }
      if (refused.length > 0) return err({ code: 'claim-text.refused', fields: refused });
    }

    try {
      return await deps.unitOfWork.run<OwnOfferSubmitOutput, OwnOfferSubmitFailure>(
        market,
        async () => {
          const offer = await deps.offers.findById(market, offerId.value);
          if (
            offer === null ||
            offer.state.sellerId !== sellerId ||
            offer.state.status === 'deleted'
          ) {
            return err({ code: 'offer.not-found' } as const);
          }
          if (offer.state.version !== version) return err({ code: 'conflict.stale' } as const);
          let approvalRequired: boolean;
          try {
            approvalRequired = await deps.policy.approvalRequired(market);
          } catch {
            return err({ code: 'access.unavailable' } as const);
          }
          const submitted = offer.submit({ approvalRequired, now: deps.clock.now() });
          if (!submitted.ok) {
            return err(
              submitted.error.code === 'offer.handling-missing'
                ? ({ code: 'offer.handling-missing' } as const)
                : ({ code: 'offer.not-submittable' } as const),
            );
          }
          await deps.offers.save(market, offer, { kind: 'seller', accountId: actor.accountId });
          await deps.outbox.append(context, offer.pendingEvents);
          return ok({ published: submitted.value.published });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
