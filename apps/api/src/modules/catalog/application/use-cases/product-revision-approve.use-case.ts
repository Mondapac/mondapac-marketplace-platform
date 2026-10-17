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
import {
  loadPendingForReview,
  parseProductDecision,
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
 * Images of the revision are visible through the published revision from then on. The re-asking of
 * the owner's Offer tags (design 5.1a point 3) and audit and mail join with slice 8 and the
 * notification module.
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

    try {
      return await deps.unitOfWork.run<Record<string, never>, ProductRevisionApproveFailure>(
        market,
        async () => {
          // Read again in the unit: the product, its pending revision and the version must be
          // the ones that were checked.
          const loaded = await loadPendingForReview(deps, market, {
            productId,
            revisionId,
            version,
          });
          if (!loaded.ok) return err(loaded.error);
          const { product, revision } = loaded.value;
          if (revision.contentHash !== seen.revision.contentHash) {
            return err({ code: 'conflict.stale' } as const);
          }
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
          await deps.products.save(market, product);
          await deps.revisions.recordDecision(market, {
            revisionId,
            outcome: 'published',
            reasonCode: null,
            requiredChecks: loaded.value.requiredChecks,
            confirmedChecks: confirmed as string[],
            decidedByAccountId: actor.accountId,
            productVersion: version,
            decidedAt: now,
          });
          await deps.outbox.append(context, product.pendingEvents);
          return ok({});
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
