import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  readerScope,
  viewOf,
  type InAppNoticeDependencies,
  type NoticeView,
  type OwnNoticesFailure,
} from '../in-app-notice-flow';

export interface CountOwnUnreadNoticesOutput {
  readonly unread: number;
  /**
   * The newest unread notice, so the panel can tell that something new arrived since its last
   * poll (the order sound) without loading the list; null when nothing is unread.
   */
  readonly newest: NoticeView | null;
}

/**
 * `notifications.count-own-unread-notices` (in-app notifications package 1): what the bell
 * polls. The number of notices the signed-in seller-side member (or admin, package 3) may see and
 * has not read, and the newest of them. Rule `own-resources`, scoped as {@link ListOwnNotices}. One read-only unit.
 */
export class CountOwnUnreadNotices extends UseCase<
  Record<string, never>,
  CountOwnUnreadNoticesOutput,
  OwnNoticesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.count-own-unread-notices',
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
  ): Promise<Result<CountOwnUnreadNoticesOutput, OwnNoticesFailure>> {
    const scope = await readerScope(this.deps, context);
    if (!scope.ok) return scope;
    if (scope.value.kinds.length === 0) return ok({ unread: 0, newest: null });
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () => ok(await this.deps.notices.unread(context.market, scope.value)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.denied' });
    const { count, newest } = read.value;
    return ok({ unread: count, newest: newest === null ? null : viewOf(newest) });
  }
}
