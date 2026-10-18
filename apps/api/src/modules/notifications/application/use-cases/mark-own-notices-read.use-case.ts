import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  sellerReaderScope,
  type InAppNoticeDependencies,
  type OwnNoticesFailure,
} from '../in-app-notice-flow';

export interface MarkOwnNoticesReadInput {
  /** One notice id from the path, or every notice in scope ("Mark all as read"). */
  readonly target: { readonly all: true } | { readonly id: unknown };
}

export interface MarkOwnNoticesReadOutput {
  /** How many notices became read by this call (0 when they already were). */
  readonly marked: number;
}

export type MarkOwnNoticesReadFailure =
  OwnNoticesFailure | { readonly code: 'notifications.notice-not-found' };

/**
 * `notifications.mark-own-notices-read` (in-app notifications package 1): the signed-in
 * seller-side member marks one notice, or every notice they may see, as read for themselves; the
 * other members' read state is their own. Rule `own-resources`: a notice outside the member's
 * scope (another seller's, a kind they may not see, past retention) is `notice-not-found`, the
 * same answer as an unknown id. Marking a read notice again changes nothing.
 */
export class MarkOwnNoticesRead extends UseCase<
  MarkOwnNoticesReadInput,
  MarkOwnNoticesReadOutput,
  MarkOwnNoticesReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.mark-own-notices-read',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InAppNoticeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MarkOwnNoticesReadInput,
  ): Promise<Result<MarkOwnNoticesReadOutput, MarkOwnNoticesReadFailure>> {
    let target: Id<'InAppNotice'> | 'all';
    if ('all' in input.target) target = 'all';
    else {
      const { id } = input.target;
      const parsed = typeof id === 'string' ? parseId(id) : null;
      if (parsed === null || !parsed.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'id', code: 'format' }] });
      }
      target = parsed.value as Id<'InAppNotice'>;
    }
    const scope = await sellerReaderScope(this.deps, context);
    if (!scope.ok) return scope;
    if (scope.value.kinds.length === 0) {
      return target === 'all' ? ok({ marked: 0 }) : err({ code: 'notifications.notice-not-found' });
    }
    const now = this.deps.clock.now();
    const done = await this.deps.unitOfWork.run(context.market, async () => {
      if (
        target !== 'all' &&
        !(await this.deps.notices.existsForSeller(context.market, scope.value, target))
      ) {
        return err({ code: 'notifications.notice-not-found' as const });
      }
      const ids = await this.deps.notices.unreadIdsForSeller(
        context.market,
        scope.value,
        target === 'all' ? 'all' : [target],
      );
      return ok(await this.deps.notices.markRead(context.market, scope.value.accountId, ids, now));
    });
    if (!done.ok) return done;
    return ok({ marked: done.value });
  }
}
