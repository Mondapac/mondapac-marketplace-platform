import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_PROPOSAL_DECIDE } from '../../contracts/permissions';
import { CategoryProposalRejectedAudit } from '../../domain/audit';
import { CategoryProposalRejected } from '../../domain/events';
import { PROPOSAL_REJECT_REASONS, type ProposalRejectReason } from '../../domain/seller-category';
import { closedInput, editorAccountOf, invalid, versionOf } from '../categories/category-editor';
import {
  proposalIdOf,
  type ShelfWriteDependencies,
  type ValidationFailure,
} from '../seller-categories/seller-category-shared';
import type { CategoryProposalDecideInput } from './category-proposal-approve.use-case';

export type CategoryProposalRejectFailure =
  | ValidationFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'category-proposal.not-found' }
  | { readonly code: 'category-proposal.not-pending' }
  | { readonly code: 'conflict.stale' };

const isReason = (value: unknown): value is ProposalRejectReason =>
  typeof value === 'string' && (PROPOSAL_REJECT_REASONS as readonly string[]).includes(value);

/**
 * `category-proposal.reject` (categories C9a; CAT-52; ux FP8 row 4). Rule: the key
 * `catalog.category-proposal.decide`, the admin population, never an acting-as session. The body
 * names the version the page read and one prepared reason code (never free text). One unit:
 * decision, audit, event.
 */
export class CategoryProposalReject extends UseCase<
  CategoryProposalDecideInput,
  { readonly status: 'rejected'; readonly version: number },
  CategoryProposalRejectFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-proposal-reject',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_PROPOSAL_DECIDE.key] },
  };

  readonly #logger = new Logger('CategoryProposalReject');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShelfWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryProposalDecideInput,
  ): Promise<
    Result<{ readonly status: 'rejected'; readonly version: number }, CategoryProposalRejectFailure>
  > {
    const result = await this.#reject(context, input);
    this.#logger.log({
      msg: 'catalog.category-proposal-reject',
      code: result.ok ? 'rejected' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #reject(
    context: CallContext,
    input: CategoryProposalDecideInput,
  ): Promise<
    Result<{ readonly status: 'rejected'; readonly version: number }, CategoryProposalRejectFailure>
  > {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const id = proposalIdOf(input.proposalId);
    if (id === null) return err({ code: 'category-proposal.not-found' });
    const body = closedInput(input.body, ['version', 'reasonCode']);
    if (!body.ok) return body;
    const version = versionOf(body.value['version'], 'version');
    if (!version.ok) return version;
    const reason = body.value['reasonCode'];
    if (!isReason(reason)) return invalid('reasonCode', 'unknown');
    const { market } = context;
    const { deps } = this;
    return deps.unitOfWork.run<
      { readonly status: 'rejected'; readonly version: number },
      CategoryProposalRejectFailure
    >(market, async () => {
      const proposal = await deps.shelves.findProposal(market, id);
      if (proposal === null) return err({ code: 'category-proposal.not-found' } as const);
      if (proposal.status !== 'pending') {
        return err({ code: 'category-proposal.not-pending' } as const);
      }
      if (proposal.version !== version.value) return err({ code: 'conflict.stale' } as const);
      const now = deps.clock.now();
      const decided = await deps.shelves.decideProposal(
        market,
        id,
        proposal.version,
        { status: 'rejected', by: accountId, reason },
        now,
      );
      if (!decided) return err({ code: 'conflict.stale' } as const);
      const next = proposal.version + 1;
      const { sellerId } = proposal;
      await deps.audit.record(
        context,
        CategoryProposalRejectedAudit.entry(id, { after: { sellerId, reasonCode: reason } }),
      );
      await deps.outbox.append(context, [
        CategoryProposalRejected.record({
          aggregateId: id,
          aggregateVersion: next,
          occurredAt: now,
          payload: { proposalId: id, sellerId },
        }),
      ]);
      return ok({ status: 'rejected' as const, version: next });
    });
  }
}
