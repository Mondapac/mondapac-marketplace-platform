import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { NOTICE_PAGE_SIZE } from '../../domain/in-app-notice';
import type { NoticeFilter } from '../ports/in-app-notice.repository';

/** The list's filters (john 2026-10-17): unread, read, all; unread first. */
const NOTICE_FILTERS: readonly NoticeFilter[] = ['unread', 'read', 'all'];
import {
  sellerReaderScope,
  viewOf,
  withCustomerNames,
  type InAppNoticeDependencies,
  type ListedNoticeView,
  type NoticeView,
  type OwnNoticesFailure,
} from '../in-app-notice-flow';

export interface ListOwnNoticesInput {
  /** The last id of the previous page, from the query string; absent for the first page. */
  readonly before?: unknown;
  /** `unread` (the default), `read` or `all`, from the query string. */
  readonly show?: unknown;
}

export interface ListOwnNoticesOutput {
  /** Newest first, each order notice with the customer's short name when the member may see it. */
  readonly items: readonly ListedNoticeView[];
  /** The `before` of the next page; null on the last page. */
  readonly next: Id<'InAppNotice'> | null;
}

/**
 * `notifications.list-own-notices` (in-app notifications package 1): the notices the signed-in
 * seller-side member may see, newest first, a page at a time, each with whether this member has
 * read it, filtered by this member's read state (unread by default, read, or all). Rule `own-resources`: the seller and the account are the actor's own, so nobody reads
 * another seller's notices, and each kind is shown only while the member holds its permission.
 * One read-only unit; then, outside it, one ordering call adds the customers' short names (shown
 * only to a member holding `identity.customer-short-name.view`; never stored).
 */
export class ListOwnNotices extends UseCase<
  ListOwnNoticesInput,
  ListOwnNoticesOutput,
  OwnNoticesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.list-own-notices',
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
    input: ListOwnNoticesInput,
  ): Promise<Result<ListOwnNoticesOutput, OwnNoticesFailure>> {
    let before: Id<'InAppNotice'> | null = null;
    if (input.before !== undefined) {
      const parsed = typeof input.before === 'string' ? parseId(input.before) : null;
      if (parsed === null || !parsed.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'before', code: 'format' }] });
      }
      before = parsed.value as Id<'InAppNotice'>;
    }
    let show: NoticeFilter = 'unread';
    if (input.show !== undefined) {
      if (!NOTICE_FILTERS.includes(input.show as NoticeFilter)) {
        return err({ code: 'validation.failed', fields: [{ path: 'show', code: 'enum' }] });
      }
      show = input.show as NoticeFilter;
    }
    const scope = await sellerReaderScope(this.deps, context);
    if (!scope.ok) return scope;
    if (scope.value.kinds.length === 0) return ok({ items: [], next: null });
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () =>
        ok(
          await this.deps.notices.listForSeller(context.market, scope.value, {
            before,
            limit: NOTICE_PAGE_SIZE,
            show,
          }),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.denied' });
    const rows = read.value;
    const views = rows.map(viewOf).filter((item): item is NoticeView => item !== null);
    const items = await withCustomerNames(this.deps, context, views);
    return ok({ items, next: rows.length === NOTICE_PAGE_SIZE ? rows.at(-1)!.id : null });
  }
}
