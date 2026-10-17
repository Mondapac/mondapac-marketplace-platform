import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import { revisionTextsOf } from '../../domain/revision-texts';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnOfferFinder } from '../ports/own-offer-finder';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  askPrepared,
  claimsFailClosed,
  hashesOf,
  MAX_CLAIM_ATTEMPTS,
  NOTHING_ASKED,
  openTagTypes,
  RETRY,
  type PreparedAsk,
} from '../tags/offer-claims';
import {
  loadPendingForReview,
  parseProductDecision,
  type PendingRevisionForReview,
  type PendingRevisionLoadFailure,
  type ProductReviewRefusal,
  type ReviewValidationFailure,
} from '../revisions/pending-revision-review';
import { REVIEW_CHECK_CODES } from '../revisions/review-checks';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';

export interface ProductRevisionApproveInput {
  readonly productId: string;
  /** The pending revision the reviewer saw. */
  readonly revisionId: string;
  /** The product version the reviewer saw. */
  readonly version: number;
  /** The named checks the reviewer ticked (design 8.3a). */
  readonly checksConfirmed: readonly string[];
}

export type ProductRevisionApproveFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-eligible' }
  | {
      readonly code: 'review.checks-missing';
      readonly issues: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'conflict.retry' }
  | PendingRevisionLoadFailure
  | ProductReviewRefusal
  | ReviewValidationFailure;

export interface ProductRevisionApproveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly revisions: ProductRevisionRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly check: CheckClaimText;
  readonly policy: CatalogMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  /** The owner's Offer of the product, read with its open tags (design 5.1a). */
  readonly offerFinder: OwnOfferFinder;
  readonly offers: OfferRepository;
  /** The claim facts and queries (design 5.1). */
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
}

/**
 * `product-revision.approve` (catalog design 4.2 row 3, 8.2, 8.3a; AC 29): a reviewer publishes the
 * pending revision of a seller's product. Rule: the key `catalog.product.approve` and the admin
 * population. The request names the product, the pending revision and the product version the
 * reviewer saw, and the named checks they ticked. Guards, in order: the revision is the pending one
 * and the version is current (`review.not-current-revision`, `conflict.stale`); every check the
 * server derives for the revision is ticked (`review.checks-missing`, with the codes); the owner
 * may still sell (`seller.not-eligible`); every text of the revision passes the claim-text control
 * again, since the vocabulary can have grown since the submit. In one unit the product is read
 * again at the same version, the aggregate moves the published pointer (the previous revision is
 * superseded, variants are announced, M-1), the decision row and the events are stored together.
 * Images of the revision are visible through the published revision from then on.
 *
 * Tags (design 5.1a point 3; slice 11, Hassan M1 condition of slice 8): before the unit, every tag
 * of the owner's Offer that is not removed (`pending-publish` included) is asked again against
 * revision N, the one being published. In the unit the Offer must be at the version asked about
 * (else the attempt asks again) and the facts are rebuilt from the live tree; the pointer moves
 * only together with the settle of those decisions: an allowed tag is `active`, a refused one
 * `suspended` (the Offer goes off sale). An unanswered ask refuses the approval
 * (`claim.check-unavailable`, nothing moves); a lost race asks again, at most three times, then
 * `conflict.retry`. Audit and mail join with the notification module.
 */
export class ProductRevisionApprove extends UseCase<
  ProductRevisionApproveInput,
  Record<string, never>,
  ProductRevisionApproveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.product-revision-approve',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  readonly #logger = new Logger('ProductRevisionApprove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductRevisionApproveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductRevisionApproveInput,
  ): Promise<Result<Record<string, never>, ProductRevisionApproveFailure>> {
    const result = await this.#approve(context, input);
    this.#logger.log({
      msg: 'catalog.product-revision-approve',
      code: result.ok ? 'approved' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #approve(
    context: CallContext,
    input: ProductRevisionApproveInput,
  ): Promise<Result<Record<string, never>, ProductRevisionApproveFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const parsed = parseProductDecision(input, ['checksConfirmed']);
    if (!parsed.ok) return parsed;
    const { productId, revisionId, version, raw } = parsed.value;
    const confirmed = raw['checksConfirmed'];
    if (
      !Array.isArray(confirmed) ||
      confirmed.length > REVIEW_CHECK_CODES.length ||
      confirmed.some(
        (code) =>
          typeof code !== 'string' || !(REVIEW_CHECK_CODES as readonly string[]).includes(code),
      ) ||
      new Set(confirmed).size !== confirmed.length
    ) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'checksConfirmed', code: 'unknown' }],
      });
    }
    const { deps } = this;

    let locales: { readonly default: string; readonly supported: readonly string[] };
    let maxVariants: number;
    try {
      locales = deps.policy.locales(market);
      maxVariants = deps.policy.maxVariantsPerProduct(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }

    const guard = await deps.unitOfWork.run(
      market,
      async () => ok(await loadPendingForReview(deps, market, { productId, revisionId, version })),
      { readOnly: true },
    );
    if (!guard.ok) return err({ code: 'access.unavailable' });
    if (!guard.value.ok) return err(guard.value.error);
    const seen = guard.value.value;

    const missing = seen.requiredChecks.filter((code) => !confirmed.includes(code));
    if (missing.length > 0) {
      return err({
        code: 'review.checks-missing',
        issues: missing.map((code) => ({ path: 'checksConfirmed', code })),
      });
    }
    if (!(await deps.eligibility.isEligible(context, seen.ownerSellerId))) {
      return err({ code: 'seller.not-eligible' });
    }

    // Every text of the revision again, outside any unit (the control opens its own).
    const texts = revisionTextsOf(seen.revision.content, locales.supported, locales.default);
    if (!texts.ok) return err({ code: 'access.unavailable' });
    if (texts.value.length > 0) {
      const checked = await deps.check.execute(
        context,
        texts.value.map(({ field, ref, locale, text }) => ({ field, ref, locale, text })),
      );
      if (!checked.ok) {
        return err(
          checked.error.code === 'access.denied'
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

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await claimsFailClosed(() =>
        this.#publish(
          context,
          { productId, revisionId, version },
          seen,
          confirmed as string[],
          maxVariants,
        ),
      );
      if (outcome !== RETRY) return outcome;
    }
    return err({ code: 'conflict.retry' });
  }

  /**
   * One attempt of the publication: the owner's Offer's tags asked against revision N outside
   * any unit (5.1a point 3), then one unit that moves the pointer and settles the tags on those
   * decisions. {@link RETRY} when the Offer or the claim facts moved since the ask.
   */
  async #publish(
    context: CallContext,
    ids: {
      readonly productId: Id<'Product'>;
      readonly revisionId: Id<'ProductRevision'>;
      readonly version: number;
    },
    seen: PendingRevisionForReview,
    confirmed: readonly string[],
    maxVariants: number,
  ): Promise<Result<Record<string, never>, ProductRevisionApproveFailure> | typeof RETRY> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const { deps } = this;
    const { productId, revisionId, version } = ids;

    // The owner's Offer and every tag that is not removed, against the revision being published.
    const read = await deps.unitOfWork.run<
      { readonly offerVersion: number | null; readonly prepared: PreparedAsk | 'unavailable' },
      never
    >(
      market,
      async () => {
        const offer = await deps.offerFinder.findOwnOnProduct(
          market,
          seen.ownerSellerId,
          productId,
        );
        if (offer === null) return ok({ offerVersion: null, prepared: NOTHING_ASKED });
        const types = openTagTypes(offer);
        if (types.length === 0) {
          return ok({ offerVersion: offer.state.version, prepared: NOTHING_ASKED });
        }
        const facts = await deps.claims.revisionFacts(
          market,
          seen.product,
          revisionId,
          seen.revision.content,
          true,
        );
        const queries = deps.claims.queries(offer.state, facts, types);
        return ok({
          offerVersion: offer.state.version,
          prepared: queries === null ? 'unavailable' : { facts, queries, productVersion: version },
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { offerVersion, prepared } = read.value;
    if (prepared === 'unavailable') return err({ code: 'claim.check-unavailable' });
    // Fail closed: an unanswered ask leaves the revision pending; the reviewer tries again.
    const asked = await askPrepared(deps.evaluator, context, prepared);
    if (!asked.ok) return err(asked.error);
    const hash = hashesOf(prepared);

    try {
      const written = await deps.unitOfWork.run<
        Record<string, never> | typeof RETRY,
        ProductRevisionApproveFailure
      >(market, async () => {
        // Read again in the unit: the product, its pending revision and the version must be
        // the ones that were checked.
        const loaded = await loadPendingForReview(deps, market, { productId, revisionId, version });
        if (!loaded.ok) return err(loaded.error);
        const { product, revision } = loaded.value;
        if (revision.contentHash !== seen.revision.contentHash) {
          return err({ code: 'conflict.stale' } as const);
        }
        const offer = await deps.offerFinder.findOwnOnProduct(
          market,
          seen.ownerSellerId,
          productId,
        );
        if ((offer?.state.version ?? null) !== offerVersion) return ok(RETRY);
        const now = deps.clock.now();
        const approved = product.approveRevision({
          revisionId,
          baseRevisionId: revision.baseRevisionId,
          revisionVariantIds: revision.content.variants.map(
            (variant) => variant.variantId as Id<'Variant'>,
          ),
          maxVariants,
          now,
        });
        if (!approved.ok) return err(approved.error as ProductReviewRefusal);
        if (offer !== null && prepared.queries.size > 0) {
          // The facts again, in this unit, from the live tree: decisions are judged against
          // them, never against the ones the ask was built on.
          const facts = await deps.claims.revisionFacts(
            market,
            product,
            revisionId,
            revision.content,
            true,
          );
          const settled = offer.settlePublish({
            facts,
            decisions: asked.value,
            entryPath: 'revision-publish',
            actor: { kind: 'admin', accountId: actor.accountId },
            hash,
            now,
          });
          if (!settled.ok) {
            if (settled.error.code === 'claim.inputs-changed') return ok(RETRY);
            return err({ code: 'claim.check-unavailable' } as const);
          }
        }
        // Nothing is written before this point, so a retry above commits nothing. The product
        // row first, then the Offer (the lock order of every tag write, slice 11).
        await deps.products.save(market, product);
        await deps.revisions.recordDecision(market, {
          revisionId,
          outcome: 'published',
          reasonCode: null,
          requiredChecks: loaded.value.requiredChecks,
          confirmedChecks: [...confirmed],
          decidedByAccountId: actor.accountId,
          productVersion: version,
          decidedAt: now,
        });
        await deps.outbox.append(context, product.pendingEvents);
        if (offer !== null && offer.hasChanges) {
          await deps.offers.save(market, offer, { kind: 'admin', accountId: actor.accountId });
          await deps.outbox.append(context, offer.pendingEvents);
        }
        return ok({});
      });
      if (written.ok && written.value === RETRY) return RETRY;
      return written as Result<Record<string, never>, ProductRevisionApproveFailure>;
    } catch (error) {
      if (error instanceof StaleAggregateError) {
        // A tag write on the Offer won the race: ask again. The product moved: the page is stale.
        return error.aggregateType === 'offer' ? RETRY : err({ code: 'conflict.stale' });
      }
      throw error;
    }
  }
}
