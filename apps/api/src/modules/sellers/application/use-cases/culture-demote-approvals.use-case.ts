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
 * (approved to requested), never grant anything. At most 10 batches of 200, one unit each.
 * Also the handler of `catalog.culture-approvals-invalidated.v1` (security review N1): that
 * delivery is retried until `remaining` is false.
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

  protected handle(
    context: CallContext,
    input: CultureDemoteApprovalsInput,
  ): Promise<Result<CultureDemoteApprovalsResult, CultureDemoteApprovalsFailure>> {
    return demoteApprovals(this.deps, context, input);
  }
}

/** The shared body of the pair: at most 10 batches of 200, one unit each. */
export async function demoteApprovals(
  deps: CultureDemoteApprovalsDependencies,
  context: CallContext,
  input: CultureDemoteApprovalsInput,
): Promise<Result<CultureDemoteApprovalsResult, CultureDemoteApprovalsFailure>> {
  const id = typeof input?.cultureId === 'string' ? parseId<'Culture'>(input.cultureId) : null;
  if (id === null || !id.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'cultureId', code: 'format' }] });
  }
  const { market } = context;
  // One unit per batch of 200 (Mojtaba, review of #844): a unit stays far below the 5 s unit
  // timeout, and a batch that committed stays demoted when a later one fails.
  let demoted = 0;
  try {
    for (let batch = 0; batch < DEMOTE_MAX_BATCHES; batch += 1) {
      const step = await deps.unitOfWork.run<
        { readonly moved: number; readonly empty: boolean },
        never
      >(market, async () => {
        const rows = await deps.sellerCultures.approvedIn(market, id.value, DEMOTE_BATCH);
        if (rows.length === 0) return ok({ moved: 0, empty: true });
        const at = deps.clock.now();
        let moved = 0;
        for (const state of rows) {
          const next = demoteMembership(state, at);
          const won = await deps.sellerCultures.transition(market, next, {
            version: state.version,
            status: 'approved',
          });
          if (!won) continue;
          await announce(deps.outbox, context, next);
          moved += 1;
        }
        return ok({ moved, empty: false });
      });
      if (!step.ok) return err({ code: 'sellers.unavailable' });
      if (step.value.empty) return ok({ demoted, remaining: false });
      demoted += step.value.moved;
      if (step.value.moved === 0) return ok({ demoted, remaining: true });
    }
    const left = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.sellerCultures.approvedIn(market, id.value, 1)),
      { readOnly: true },
    );
    if (!left.ok) return err({ code: 'sellers.unavailable' });
    return ok({ demoted, remaining: left.value.length > 0 });
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
}
