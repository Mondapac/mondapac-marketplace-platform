import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AccessDeclaration, AuthorisationCheck } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { ORDERING_SELLER_ORDER_VIEW, type OrderingFacade } from '../../ordering';
import {
  NOTICE_RETENTION_DAYS,
  parseNoticeParams,
  SELLER_NOTICE_KINDS,
  SELLER_ORDER_PAID,
  type NoticeParams,
  type SellerNoticeKind,
} from '../domain/in-app-notice';
import type {
  InAppNoticeRepository,
  SellerNoticeScope,
  StoredNotice,
} from './ports/in-app-notice.repository';

export interface InAppNoticeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly notices: InAppNoticeRepository;
  readonly ordering: OrderingFacade;
  readonly authorisation: AuthorisationCheck;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** One notice as a panel receives it: the panel renders the text and the link from these. */
export interface NoticeView {
  readonly id: Id<'InAppNotice'>;
  readonly kind: string;
  readonly params: NoticeParams;
  /** ISO 8601 instant (UTC). */
  readonly createdAt: string;
  readonly read: boolean;
}

export type OwnNoticesFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/**
 * The permission a reader must hold to see each seller kind. Checked on every read, so a member
 * who loses the permission stops seeing those notices at once, and a member who gains it sees the
 * ones already there. These declarations are never executed as use cases; they are only asked of
 * the AuthorisationCheck, as `sellers.list-status` is.
 */
const SELLER_KIND_ACCESS: Readonly<Record<SellerNoticeKind, AccessDeclaration>> = {
  [SELLER_ORDER_PAID]: {
    name: 'notifications.see-seller-order-notices',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
  },
};

const logger = new Logger('InAppNotices');

/**
 * The scope of a seller-side reader: the actor's own seller and account, and only the kinds whose
 * permission the actor holds now. Refused for anyone but an authenticated seller-side member.
 */
export async function sellerReaderScope(
  deps: InAppNoticeDependencies,
  context: CallContext,
): Promise<Result<SellerNoticeScope, { readonly code: 'access.denied' }>> {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller' || actor.sellerId === null) {
    return err({ code: 'access.denied' });
  }
  const kinds: SellerNoticeKind[] = [];
  for (const kind of SELLER_NOTICE_KINDS) {
    try {
      if ((await deps.authorisation.check(context, SELLER_KIND_ACCESS[kind])).allowed) {
        kinds.push(kind);
      }
    } catch (error) {
      // Fail closed: a kind whose permission cannot be checked is not shown.
      logger.error({
        msg: 'notifications.notice-kind-check-failed',
        kind,
        error: error instanceof Error ? error.name : 'unknown',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    }
  }
  return ok({
    sellerId: actor.sellerId,
    accountId: actor.accountId,
    kinds,
    since: retentionEdge(deps.clock),
  });
}

/** The oldest instant still shown and kept. */
export function retentionEdge(clock: Clock): Temporal.Instant {
  return clock.now().subtract(Temporal.Duration.from({ hours: NOTICE_RETENTION_DAYS * 24 }));
}

/** A stored row as a panel sees it; a row whose params do not fit its kind is left out. */
export function viewOf(row: StoredNotice): NoticeView | null {
  const params = parseNoticeParams(row.kind, row.params);
  if (params === null) return null;
  return {
    id: row.id,
    kind: row.kind,
    params,
    createdAt: row.createdAt.toString(),
    read: row.read,
  };
}
