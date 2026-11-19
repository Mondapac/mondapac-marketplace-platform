import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_PROPOSAL_DECIDE } from '../../contracts/permissions';
import { PROPOSAL_REJECT_REASONS } from '../../domain/seller-category';
import { parseBulkItems, runBulkDecide } from '../lists/bulk-decide';
import type { CategoryProposalApprove } from './category-proposal-approve.use-case';
import type { CategoryProposalReject } from './category-proposal-reject.use-case';
import {
  adminOnly,
  closed,
  refuse,
  type BulkDecideOutput,
  type BulkDecideRefusal,
} from '../lists/bulk-decide-shared';

export interface CategoryProposalBulkDecideDependencies {
  readonly proposalApprove: CategoryProposalApprove;
  readonly proposalReject: CategoryProposalReject;
}

/** `category-proposal.bulk-decide`: approve, or reject with one reason code, up to 50 proposals. */
export class CategoryProposalBulkDecide extends UseCase<
  unknown,
  BulkDecideOutput,
  BulkDecideRefusal
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-proposal-bulk-decide',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_PROPOSAL_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryProposalBulkDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<BulkDecideOutput, BulkDecideRefusal>> {
    if (!adminOnly(context)) return err({ code: 'access.denied' });
    const body = closed(input, ['action', 'items', 'reasonCode']);
    if (!body.ok) return body;
    const items = parseBulkItems(body.value['items']);
    if (!items.ok) return items;
    const action = body.value['action'];
    if (action === 'approve') {
      if (body.value['reasonCode'] !== undefined) return refuse('reasonCode', 'unknown');
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.proposalApprove.execute(context, {
          proposalId: item.id,
          body: { version: item.version },
        }),
      );
      return ok({ action, ...done });
    }
    if (action === 'reject') {
      const reasonCode = body.value['reasonCode'];
      if (
        typeof reasonCode !== 'string' ||
        !(PROPOSAL_REJECT_REASONS as readonly string[]).includes(reasonCode)
      ) {
        return refuse('reasonCode', 'unknown');
      }
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.proposalReject.execute(context, {
          proposalId: item.id,
          body: { version: item.version, reasonCode },
        }),
      );
      return ok({ action, ...done });
    }
    return refuse('action', 'value');
  }
}
