import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellerAccessContract } from '../../identity/contracts/seller-access.contract';
import type {
  AccessDecisionAnswer,
  DecisionByBasis,
  SellerAccessDecider,
} from '../application/ports/seller-access-decider';
import { DECISION_CALL_DEADLINE_MS } from '../domain/decision-intent';

/** The call into `identity` did not answer within its deadline (design 7.3, Hassan M3). */
export class DecisionDeadlineExceeded extends Error {
  override readonly name = 'DecisionDeadlineExceeded';
  constructor() {
    super('identity did not answer the decision within its deadline');
  }
}

/**
 * {@link SellerAccessDecider} on `identity`'s seller-access contract (ADR-0022 decision 4; R-1):
 * the reviewer's context goes through unchanged, `basisId` is the revision id. A gate refusal is a
 * refusal like any other (`access.denied`). The reason is passed on and never kept or logged.
 */
export class IdentitySellerAccessDecider implements SellerAccessDecider {
  constructor(
    private readonly identity: SellerAccessContract,
    private readonly deadlineMs: number = DECISION_CALL_DEADLINE_MS,
  ) {}

  approve(
    context: CallContext,
    sellerId: Id<'Seller'>,
    basisId: Id<'BusinessFileRevision'>,
  ): Promise<AccessDecisionAnswer> {
    return this.bounded(async () => {
      const result = await this.identity.approveSellerAccess(context, sellerId, basisId);
      return result.ok
        ? { kind: 'decided', decisionId: result.value.decisionId }
        : { kind: 'refused', code: result.error.code };
    });
  }

  reject(
    context: CallContext,
    sellerId: Id<'Seller'>,
    reason: string,
    basisId: Id<'BusinessFileRevision'>,
  ): Promise<AccessDecisionAnswer> {
    return this.bounded(async () => {
      const result = await this.identity.rejectSellerAccess(context, sellerId, reason, basisId);
      if (result.ok) return { kind: 'decided', decisionId: result.value.decisionId };
      return 'rule' in result.error
        ? { kind: 'refused', code: result.error.code, rule: result.error.rule }
        : { kind: 'refused', code: result.error.code };
    });
  }

  async decisionsByBasis(
    context: CallContext,
    items: readonly {
      readonly sellerId: Id<'Seller'>;
      readonly basisId: Id<'BusinessFileRevision'>;
    }[],
  ): Promise<readonly DecisionByBasis[]> {
    if (items.length === 0) return [];
    const result = await this.identity.accessDecisionsByBasis(context, items);
    if (!result.ok)
      throw new Error(`identity.accessDecisionsByBasis refused: ${result.error.code}`);
    return result.value.map((row) => ({
      sellerId: row.sellerId,
      basisId: row.basisId as Id<'BusinessFileRevision'>,
      decisionId: row.decisionId,
      kind: row.kind,
    }));
  }

  /** Races the call against the deadline; a late answer is dropped (the intent stays). */
  private async bounded<T>(call: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DecisionDeadlineExceeded()), this.deadlineMs);
    });
    try {
      return await Promise.race([call(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
