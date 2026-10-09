import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { Offer, OfferRefusal } from '../../domain/offer';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import { parseOfferContent } from '../offer-content';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';

/** The request as the route passes it: the whole content form, a closed shape (B1, L8). */
export interface OwnOfferEditInput {
  readonly offerId: string;
  readonly sellerSku: string;
  readonly conditionCode: string;
  /** Locale to text; empty is allowed. */
  readonly description: unknown;
}

export interface OwnOfferEditOutput {
  /** Field ids that changed; empty when the form matched what was stored (nothing was stored). */
  readonly changedFields: readonly string[];
}

export type OwnOfferEditFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.not-editable' }
  | { readonly code: 'offer.sku-taken' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferEditDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly check: CheckClaimText;
  /** Spends the account's save budget (design 8.4: an Offer edit shares the draft-save limits). */
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  readonly policy: CatalogMarketPolicy;
  readonly clock: Clock;
}

const INPUT_KEYS = ['offerId', 'sellerSku', 'conditionCode', 'description'] as const;

/**
 * `own-offer.edit` (catalog design 4.4, 8.2; OFR-01): a seller edits the content of their own
 * Offer that is not yet published. Rule: the key `catalog.own-product.edit` and the seller
 * population. The seller comes from the actor, never from the request; the input is the whole
 * content form and is closed, with no handling, attestation or tag field (B1).
 *
 * Guards, in order: the seller may sell; the input is well formed (closed shape, the condition is
 * one of the Market's, the description fits the Market's locales and size bounds); the account's
 * save budget is spent (`request.throttled`; shared with draft saves, so a loop of edits is
 * bounded before any read or matcher call); the Offer exists, is the actor's and is not deleted,
 * else a byte-identical `offer.not-found` (another seller's Offer reveals nothing); the locales
 * whose text changed pass the claim-text control (a hit refuses the whole edit, nothing is
 * stored; an unchanged text is not re-checked). In one unit the Offer is read again, edited and
 * stored with its history row. A `pending-first-publish` or `changes-needed` Offer returns to
 * `draft`. A published Offer is `offer.not-editable` until slice 8 re-asks every tag.
 */
export class OwnOfferEdit extends UseCase<
  OwnOfferEditInput,
  OwnOfferEditOutput,
  OwnOfferEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-edit',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    // A seller who is not approved cannot edit Offers.
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferEdit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferEditDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferEditInput,
  ): Promise<Result<OwnOfferEditOutput, OwnOfferEditFailure>> {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-edit',
      code: result.ok ? 'edited' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: OwnOfferEditInput,
  ): Promise<Result<OwnOfferEditOutput, OwnOfferEditFailure>> {
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
    const parsed = this.#parse(market, input);
    if (!parsed.ok) return parsed;
    const { offerId, sellerSku, conditionCode, description } = parsed.value;

    // Spent before any read or the claim matcher, so a loop of edits is bounded.
    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    // Read-only first: the ownership answer and the texts that changed since the last save.
    const guard = await deps.unitOfWork.run(
      market,
      async () => ok(await this.#ownOffer(market, offerId, sellerId)),
      { readOnly: true },
    );
    if (!guard.ok) return err({ code: 'access.unavailable' });
    if (guard.value === null) return err({ code: 'offer.not-found' });
    const stored = guard.value.state.description;
    const guardVersion = guard.value.state.version;

    // The claim-text control runs outside any unit (it opens its own); a hit refuses the edit.
    const texts = Object.entries(description).filter(
      ([locale, text]) => text !== '' && stored[locale] !== text,
    );
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

    try {
      return await deps.unitOfWork.run<OwnOfferEditOutput, OwnOfferEditFailure>(
        market,
        async () => {
          const offer = await this.#ownOffer(market, offerId, sellerId);
          if (offer === null) return err({ code: 'offer.not-found' } as const);
          // The changed texts were checked against the first read: another edit in between
          // means the baseline is stale, so nothing is written (Hassan 7b-1 L-1).
          if (offer.state.version !== guardVersion) return err({ code: 'conflict.stale' } as const);
          const edited = offer.edit({
            sellerSku,
            conditionCode,
            description,
            now: deps.clock.now(),
          });
          if (!edited.ok) return err(failureOf(edited.error));
          const refusal = await deps.offers.save(market, offer, {
            kind: 'seller',
            accountId: actor.accountId,
          });
          if (refusal !== null) return err({ code: refusal } as const);
          return ok({ changedFields: edited.value });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }

  /** The Offer when it exists in the Market, is this seller's and is not deleted, else null. */
  async #ownOffer(
    market: MarketContext,
    offerId: Id<'Offer'>,
    sellerId: Id<'Seller'>,
  ): Promise<Offer | null> {
    const offer = await this.deps.offers.findById(market, offerId);
    if (offer === null) return null;
    const { sellerId: owner, status } = offer.state;
    return owner === sellerId && status !== 'deleted' ? offer : null;
  }

  #parse(
    market: MarketContext,
    input: OwnOfferEditInput,
  ): Result<
    {
      offerId: Id<'Offer'>;
      sellerSku: string;
      conditionCode: string;
      description: Record<string, string>;
    },
    OwnOfferEditFailure
  > {
    const fail = (path: string, code: string) =>
      err({ code: 'validation.failed', fields: [{ path, code }] } as const);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return fail('body', 'type');
    }
    for (const key of Object.keys(input)) {
      if (!(INPUT_KEYS as readonly string[]).includes(key)) return fail(key, 'unknown');
    }
    const offer = typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
    if (offer === null || !offer.ok) return fail('offerId', 'format');
    const content = parseOfferContent(this.deps.policy, market, input);
    if (!content.ok) return content;
    return ok({ offerId: offer.value, ...content.value });
  }
}

function failureOf(refusal: OfferRefusal): OwnOfferEditFailure {
  switch (refusal.code) {
    case 'offer.not-editable':
      return { code: 'offer.not-editable' };
    case 'offer.sku-invalid':
      return { code: 'validation.failed', fields: [{ path: 'sellerSku', code: 'format' }] };
    case 'offer.condition-invalid':
      return { code: 'validation.failed', fields: [{ path: 'conditionCode', code: 'format' }] };
    case 'offer.description-invalid':
      return { code: 'validation.failed', fields: [{ path: 'description', code: 'format' }] };
  }
}
