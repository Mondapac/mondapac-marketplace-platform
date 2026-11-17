import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_SELLER_CATEGORY_PROMOTE_MERGE } from '../../contracts/permissions';
import { SellerCategoryMergedAudit } from '../../domain/audit';
import { SellerCategoryMerged } from '../../domain/events';
import {
  categoryIdOf,
  closedInput,
  editorAccountOf,
  versionOf,
} from '../categories/category-editor';
import {
  LIVE_PARENT,
  lockedShelf,
  shelfIdOf,
  type ShelfWriteDependencies,
  type ValidationFailure,
} from '../seller-categories/seller-category-shared';
import { shelfRefusal, type SellerCategoryCommandInput } from './seller-category-promote.use-case';

export interface SellerCategoryMergedAnswer {
  readonly status: 'merged';
  readonly mergedIntoId: string;
  readonly offersCleared: number;
}

export type SellerCategoryMergeFailure =
  | ValidationFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'seller-category.not-found' }
  | { readonly code: 'seller-category.not-active' }
  | { readonly code: 'category.not-found' }
  | { readonly code: 'conflict.stale' };

/**
 * `seller-category.merge` (categories C9a; CAT-53 as corrected; catalog design 4.7, team decision
 * 19.2 item 9). Rule: the protected key `catalog.seller-category.promote-merge`, the admin
 * population, never an acting-as session. Terminal: an active shelf closes as `merged` into a live
 * platform category, and the shelf is **cleared** on the seller's Offers (each Offer's version
 * raised, a `shelf-cleared` history row); it is never moved, since a platform category is never a
 * shelf. The admin may then add the platform category to the products through a revision. No
 * published revision changes. The body names the shelf version the page read. Audited, with an
 * event.
 */
export class SellerCategoryMerge extends UseCase<
  SellerCategoryCommandInput,
  SellerCategoryMergedAnswer,
  SellerCategoryMergeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.seller-category-merge',
    rule: { kind: 'permissions', allOf: [CATALOG_SELLER_CATEGORY_PROMOTE_MERGE.key] },
  };

  readonly #logger = new Logger('SellerCategoryMerge');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShelfWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerCategoryCommandInput,
  ): Promise<Result<SellerCategoryMergedAnswer, SellerCategoryMergeFailure>> {
    const result = await this.#merge(context, input);
    this.#logger.log({
      msg: 'catalog.seller-category-merge',
      code: result.ok ? 'merged' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #merge(
    context: CallContext,
    input: SellerCategoryCommandInput,
  ): Promise<Result<SellerCategoryMergedAnswer, SellerCategoryMergeFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const shelfId = shelfIdOf(input.shelfId);
    if (shelfId === null) return err({ code: 'seller-category.not-found' });
    const body = closedInput(input.body, ['version', 'categoryId']);
    if (!body.ok) return body;
    const version = versionOf(body.value['version'], 'version');
    if (!version.ok) return version;
    const target = categoryIdOf(body.value['categoryId']);
    if (!target.ok) return err({ code: 'category.not-found' });
    const categoryId = target.value;
    const { market } = context;
    const { deps } = this;
    return deps.unitOfWork.run<SellerCategoryMergedAnswer, SellerCategoryMergeFailure>(
      market,
      async () => {
        const shelf = await lockedShelf(deps.shelves, market, shelfId);
        if (shelf === null) return err({ code: 'seller-category.not-found' } as const);
        const refusal = shelfRefusal(shelf, version.value);
        if (refusal !== null) return err(refusal);
        const into = await deps.shelves.platformParentState(market, categoryId);
        if (into === null || !LIVE_PARENT(into.status)) {
          return err({ code: 'category.not-found' } as const);
        }
        const closed = await deps.shelves.closeShelf(market, shelfId, shelf.version, {
          status: 'merged',
          into: categoryId,
        });
        if (!closed) return err({ code: 'conflict.stale' } as const);
        const now = deps.clock.now();
        const offersCleared = await deps.shelves.clearShelfOnOffers(
          market,
          shelfId,
          { kind: 'admin', accountId, actingAdminAccountId: null },
          now,
        );
        const { sellerId } = shelf;
        await deps.audit.record(
          context,
          SellerCategoryMergedAudit.entry(shelfId, {
            after: { sellerId, categoryId, offersCleared },
          }),
        );
        await deps.outbox.append(context, [
          SellerCategoryMerged.record({
            aggregateId: shelfId,
            aggregateVersion: shelf.version + 1,
            occurredAt: now,
            payload: { sellerCategoryId: shelfId, sellerId, categoryId },
          }),
        ]);
        return ok({ status: 'merged' as const, mergedIntoId: categoryId, offersCleared });
      },
    );
  }
}
