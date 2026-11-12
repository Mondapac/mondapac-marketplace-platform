import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { demoteMembership } from '../../domain/seller-culture';
import { announce } from '../cultures/seller-culture-views';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';

export interface CultureDemoteApprovalsInput {
  readonly cultureId: unknown;
}

export interface CultureDemoteApprovalsResult {
  readonly demoted: number;
  /** True when the per-call cap stopped the loop with approvals left: the caller treats it as a failure. */
  readonly remaining: boolean;
}

export type CultureDemoteApprovalsFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'sellers.unavailable' };

export interface CultureDemoteApprovalsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerCultures: SellerCultureRepository;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

export const DEMOTE_BATCH = 200;
export const DEMOTE_MAX_BATCHES = 10;

/**
 * `sellers.culture-demote-approvals` (ADR-0048, security review M1-R1): takes every approval of one
 * culture back to `requested` (guarded on the version, one event each). Catalog calls it only as
 * the last resort when it could not put a culture's required certification type back after an
 * approval raced with the change: the approvals were checked against the old type, so they must be
 * decided again. Rule `anonymous`; in process only, and it can only move rows in the safe direction
 * (approved to requested), never grant anything. One unit, at most 10 batches of 200.
 */
export class CultureDemoteApprovals extends UseCase<
  CultureDemoteApprovalsInput,
  CultureDemoteApprovalsResult,
  CultureDemoteApprovalsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.culture-demote-approvals',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CultureDemoteApprovalsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CultureDemoteApprovalsInput,
  ): Promise<Result<CultureDemoteApprovalsResult, CultureDemoteApprovalsFailure>> {
    const id = typeof input?.cultureId === 'string' ? parseId<'Culture'>(input.cultureId) : null;
    if (id === null || !id.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'cultureId', code: 'format' }] });
    }
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<
        CultureDemoteApprovalsResult,
        CultureDemoteApprovalsFailure
      >(market, async () => {
        let demoted = 0;
        for (let batch = 0; batch < DEMOTE_MAX_BATCHES; batch += 1) {
          const rows = await this.deps.sellerCultures.approvedIn(market, id.value, DEMOTE_BATCH);
          if (rows.length === 0) return ok({ demoted, remaining: false });
          const at = this.deps.clock.now();
          let moved = 0;
          for (const state of rows) {
            const next = demoteMembership(state, at);
            const won = await this.deps.sellerCultures.transition(market, next, {
              version: state.version,
              status: 'approved',
            });
            if (!won) continue;
            await announce(this.deps.outbox, context, next);
            moved += 1;
          }
          demoted += moved;
          if (moved === 0) return ok({ demoted, remaining: true });
        }
        const left = await this.deps.sellerCultures.approvedIn(market, id.value, 1);
        return ok({ demoted, remaining: left.length > 0 });
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
