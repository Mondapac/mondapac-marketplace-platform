import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import { OFFER_CHANGE_REASONS, type OfferChangeReason } from '../../domain/events';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import {
  loadPendingForReview,
  parseProductDecision,
  type PendingRevisionLoadFailure,
  type ProductReviewRefusal,
  type ReviewValidationFailure,
} from '../revisions/pending-revision-review';

export interface ProductRevisionRequestChangesInput {
  readonly productId: string;
  /** The pending revision the reviewer saw. */
  readonly revisionId: string;
  /** The product version the reviewer saw. */
  readonly version: number;
  /** One of {@link OFFER_CHANGE_REASONS}, the Market's list of review reasons. */
  readonly reasonCode: string;
}

export type ProductRevisionRequestChangesFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | PendingRevisionLoadFailure
  | ProductReviewRefusal
  | ReviewValidationFailure;

export interface ProductRevisionRequestChangesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly revisions: ProductRevisionRepository;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `product-revision.request-changes` (catalog design 4.2 row 5, 8.2): a reviewer sends the pending
 * revision of a seller's product back with a reason code. Rule: the key `catalog.product.approve`
 * and the admin population. The request names the product, the pending revision and the product
 * version the reviewer saw, and one reason of the closed Market list (the one Offers use); free text
 * is not accepted yet. In one unit the product is read again at the same version, the pending
 * pointer clears (the revision is terminal; the working copy stays for the next submit), the
 * decision row with the reason code is stored and `catalog.product-revision-changes-requested.v1`
 * (ids and the code) goes to the outbox. The seller reads the outcome on their product.
 */
export class ProductRevisionRequestChanges extends UseCase<
  ProductRevisionRequestChangesInput,
  Record<string, never>,
  ProductRevisionRequestChangesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.product-revision-request-changes',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  readonly #logger = new Logger('ProductRevisionRequestChanges');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductRevisionRequestChangesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductRevisionRequestChangesInput,
  ): Promise<Result<Record<string, never>, ProductRevisionRequestChangesFailure>> {
    const result = await this.#request(context, input);
    this.#logger.log({
      msg: 'catalog.product-revision-request-changes',
      code: result.ok ? 'changes-requested' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #request(
    context: CallContext,
    input: ProductRevisionRequestChangesInput,
  ): Promise<Result<Record<string, never>, ProductRevisionRequestChangesFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const parsed = parseProductDecision(input, ['reasonCode']);
    if (!parsed.ok) return parsed;
    const { productId, revisionId, version, raw } = parsed.value;
    const reason = raw['reasonCode'];
    if (
      typeof reason !== 'string' ||
      !(OFFER_CHANGE_REASONS as readonly string[]).includes(reason)
    ) {
      return err({ code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'unknown' }] });
    }
    const { deps } = this;
    try {
      return await deps.unitOfWork.run<Record<string, never>, ProductRevisionRequestChangesFailure>(
        market,
        async () => {
          const loaded = await loadPendingForReview(deps, market, {
            productId,
            revisionId,
            version,
          });
          if (!loaded.ok) return err(loaded.error);
          const { product, requiredChecks } = loaded.value;
          const now = deps.clock.now();
          const asked = product.requestRevisionChanges({
            revisionId,
            reasonCode: reason as OfferChangeReason,
            now,
          });
          if (!asked.ok) return err(asked.error as ProductReviewRefusal);
          await deps.products.save(market, product);
          await deps.revisions.recordDecision(market, {
            revisionId,
            outcome: 'changes-requested',
            reasonCode: reason,
            requiredChecks,
            confirmedChecks: [],
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
