import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_CATEGORY_PROPOSE } from '../../contracts/permissions';
import { CategoryProposalCancelledAudit } from '../../domain/audit';
import { CategoryProposalCancelled } from '../../domain/events';
import { closedInput, versionOf } from '../categories/category-editor';
import { sellerOf } from '../own-reads/own-reads.shared';
import {
  proposalIdOf,
  type ShelfWriteDependencies,
  type ValidationFailure,
} from '../seller-categories/seller-category-shared';

export interface OwnCategoryProposalCancelInput {
  readonly proposalId: string;
  readonly body: unknown;
}

export type OwnCategoryProposalCancelFailure =
  | ValidationFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'category-proposal.not-found' }
  | { readonly code: 'category-proposal.not-pending' }
  | { readonly code: 'conflict.stale' };

/**
 * `own-category-proposal.cancel` (categories C9a; CAT-51): a seller withdraws a proposal that is
 * still waiting. Rule: the key `catalog.own-category.propose`, the seller population. The body names
 * the version the page read. Another seller's or an unknown proposal is
 * `category-proposal.not-found`; a decided one `category-proposal.not-pending`; a decision that won
 * meanwhile `conflict.stale`. Not gated by `mayProposeCategories`: a seller may always withdraw.
 */
export class OwnCategoryProposalCancel extends UseCase<
  OwnCategoryProposalCancelInput,
  { readonly status: 'cancelled'; readonly version: number },
  OwnCategoryProposalCancelFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-category-proposal-cancel',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_CATEGORY_PROPOSE.key] },
    // Withdrawing is always open to the seller, approved or not.
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('OwnCategoryProposalCancel');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShelfWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnCategoryProposalCancelInput,
  ): Promise<
    Result<
      { readonly status: 'cancelled'; readonly version: number },
      OwnCategoryProposalCancelFailure
    >
  > {
    const result = await this.#cancel(context, input);
    this.#logger.log({
      msg: 'catalog.own-category-proposal-cancel',
      code: result.ok ? 'cancelled' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #cancel(
    context: CallContext,
    input: OwnCategoryProposalCancelInput,
  ): Promise<
    Result<
      { readonly status: 'cancelled'; readonly version: number },
      OwnCategoryProposalCancelFailure
    >
  > {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const id = proposalIdOf(input.proposalId);
    if (id === null) return err({ code: 'category-proposal.not-found' });
    const body = closedInput(input.body, ['version']);
    if (!body.ok) return body;
    const version = versionOf(body.value['version'], 'version');
    if (!version.ok) return version;
    const { market } = context;
    const { deps } = this;
    return deps.unitOfWork.run<
      { readonly status: 'cancelled'; readonly version: number },
      OwnCategoryProposalCancelFailure
    >(market, async () => {
      const proposal = await deps.shelves.findProposal(market, id);
      if (proposal === null || proposal.sellerId !== sellerId) {
        return err({ code: 'category-proposal.not-found' } as const);
      }
      if (proposal.status !== 'pending') {
        return err({ code: 'category-proposal.not-pending' } as const);
      }
      if (proposal.version !== version.value) return err({ code: 'conflict.stale' } as const);
      const now = deps.clock.now();
      const decided = await deps.shelves.decideProposal(
        market,
        id,
        proposal.version,
        { status: 'cancelled', reason: 'seller-cancelled' },
        now,
      );
      if (!decided) return err({ code: 'conflict.stale' } as const);
      const next = proposal.version + 1;
      await deps.audit.record(
        context,
        CategoryProposalCancelledAudit.entry(id, {
          after: { sellerId, reasonCode: 'seller-cancelled' },
        }),
      );
      await deps.outbox.append(context, [
        CategoryProposalCancelled.record({
          aggregateId: id,
          aggregateVersion: next,
          occurredAt: now,
          payload: { proposalId: id, sellerId, reasonCode: 'seller-cancelled' },
        }),
      ]);
      return ok({ status: 'cancelled' as const, version: next });
    });
  }
}
