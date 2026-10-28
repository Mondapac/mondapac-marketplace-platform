import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AccessDeclaration, AuthorisationCheck, PermissionKey } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_OWN_PRODUCT_VIEW,
  CATALOG_PRODUCT_APPROVE,
  type CatalogFacade,
} from '../../catalog';
import {
  CERTIFICATION_OWN_CERTIFICATE_VIEW,
  CERTIFICATION_SELLER_CERTIFICATE_REVIEW,
} from '../../certification';
import { TEAM_MEMBER_INVITE } from '../../identity';
import { INVENTORY_STOCK_VIEW } from '../../inventory';
import { ORDERING_SELLER_ORDER_VIEW, type OrderingFacade } from '../../ordering';
import {
  COMMISSION_PAYOUTS_EARNINGS_VIEW,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE,
} from '../../commission-payouts';
import { PRICING_PRICE_HOLD_DECIDE, PRICING_PRICE_VIEW } from '../../pricing';
import { SELLERS_SELLER_FILE_REVIEW } from '../../sellers';
import {
  ADMIN_NOTICE_KINDS,
  ADMIN_PRICE_HOLD_OPENED,
  ADMIN_SELLER_REINSTATED_HOLD_REMAINS,
  ADMIN_PRODUCT_REVISION_SUBMITTED,
  ADMIN_SELLER_CERTIFICATE_SUBMITTED,
  ADMIN_SELLER_FILE_SUBMITTED,
  NOTICE_RETENTION_DAYS,
  type AdminNoticeKind,
  parseNoticeParams,
  SELLER_ACCESS_CHANGED,
  SELLER_CERTIFICATE_DECIDED,
  SELLER_CERTIFICATE_ENDED,
  SELLER_CERTIFICATE_EXPIRING,
  SELLER_IMAGE_TAKEN_DOWN,
  SELLER_ISSUER_REQUEST_ANSWERED,
  SELLER_LOW_STOCK,
  SELLER_NOTICE_KINDS,
  SELLER_OFFER_CHANGES_REQUESTED,
  SELLER_OFFER_PUBLISHED,
  SELLER_OFFER_TAG_CHANGED,
  SELLER_ORDER_DISPUTED,
  SELLER_ORDER_PAID,
  SELLER_PAYOUT_TERMS_CHANGED,
  SELLER_PRICE_HOLD_DECIDED,
  SELLER_PRODUCT_CHANGES_REQUESTED,
  SELLER_PRODUCT_PUBLISHED,
  SELLER_RINGING_KINDS,
  type NoticeParams,
  type SellerNoticeKind,
  type SellerOrderPaidParams,
} from '../domain/in-app-notice';
import type {
  InAppNoticeRepository,
  NoticeScope,
  StoredNotice,
} from './ports/in-app-notice.repository';

export interface InAppNoticeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly notices: InAppNoticeRepository;
  readonly ordering: OrderingFacade;
  readonly catalog: CatalogFacade;
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

/**
 * One notice of the list: the view and, for a seller order notice, the customer's short name
 * ("Maryam R."), read at list time through ordering and identity, never stored on the notice.
 * Null when the member lacks `identity.customer-short-name.view`, the customer gave no name or
 * the lookup failed. PERSONAL DATA: never logged.
 */
export interface ListedNoticeView extends NoticeView {
  readonly customerShortName: string | null;
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
const SELLER_KIND_ACCESS: Readonly<Record<SellerNoticeKind, AccessDeclaration>> = (() => {
  const seeing = (name: string, key: PermissionKey): AccessDeclaration => ({
    name: `notifications.see-seller-${name}-notices`,
    rule: { kind: 'permissions', allOf: [key] },
  });
  const order = seeing('order', ORDERING_SELLER_ORDER_VIEW.key);
  const stock = seeing('stock', INVENTORY_STOCK_VIEW.key);
  const certificate = seeing('certificate', CERTIFICATION_OWN_CERTIFICATE_VIEW.key);
  const catalog = seeing('catalog', CATALOG_OWN_PRODUCT_VIEW.key);
  return {
    [SELLER_ORDER_PAID]: order,
    [SELLER_ORDER_DISPUTED]: order,
    [SELLER_PAYOUT_TERMS_CHANGED]: seeing('earnings', COMMISSION_PAYOUTS_EARNINGS_VIEW.key),
    [SELLER_LOW_STOCK]: stock,
    [SELLER_CERTIFICATE_DECIDED]: certificate,
    [SELLER_CERTIFICATE_EXPIRING]: certificate,
    [SELLER_CERTIFICATE_ENDED]: certificate,
    [SELLER_ISSUER_REQUEST_ANSWERED]: certificate,
    [SELLER_OFFER_PUBLISHED]: catalog,
    [SELLER_OFFER_CHANGES_REQUESTED]: catalog,
    [SELLER_PRODUCT_PUBLISHED]: catalog,
    [SELLER_PRODUCT_CHANGES_REQUESTED]: catalog,
    [SELLER_OFFER_TAG_CHANGED]: catalog,
    [SELLER_IMAGE_TAKEN_DOWN]: catalog,
    [SELLER_PRICE_HOLD_DECIDED]: seeing('price', PRICING_PRICE_VIEW.key),
    // The plan's "owner of the seller account": in Phase 2 only the Seller Owner holds this
    // protected key (no default role may list one), so it stands for the owner.
    [SELLER_ACCESS_CHANGED]: seeing('access', TEAM_MEMBER_INVITE.key),
  };
})();

/**
 * The permission an admin must hold to see each admin kind (package 3): the one that works the
 * queue the notice points at. Checked on every read, as {@link SELLER_KIND_ACCESS}.
 */
const ADMIN_KIND_ACCESS: Readonly<Record<AdminNoticeKind, AccessDeclaration>> = {
  [ADMIN_SELLER_CERTIFICATE_SUBMITTED]: {
    name: 'notifications.see-admin-certificate-notices',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_SELLER_CERTIFICATE_REVIEW.key] },
  },
  [ADMIN_PRODUCT_REVISION_SUBMITTED]: {
    name: 'notifications.see-admin-product-revision-notices',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  },
  [ADMIN_SELLER_FILE_SUBMITTED]: {
    name: 'notifications.see-admin-seller-file-notices',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_FILE_REVIEW.key] },
  },
  // Only the platform admin approves a held price (decision of 2026-10-17).
  [ADMIN_PRICE_HOLD_OPENED]: {
    name: 'notifications.see-admin-price-hold-notices',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_HOLD_DECIDE.key] },
  },
  // The admin who can release a payout hold works this: the seller is back, a hold remains.
  [ADMIN_SELLER_REINSTATED_HOLD_REMAINS]: {
    name: 'notifications.see-admin-reinstated-hold-notices',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE.key] },
  },
};

const logger = new Logger('InAppNotices');

/** The kinds, among `kinds`, whose permission the actor holds now. Fails closed per kind. */
async function permittedKinds<K extends string>(
  deps: InAppNoticeDependencies,
  context: CallContext,
  kinds: readonly K[],
  access: Readonly<Record<K, AccessDeclaration>>,
): Promise<K[]> {
  const permitted: K[] = [];
  // Kinds that share a declaration share its answer: one check per permission.
  const answers = new Map<AccessDeclaration, boolean>();
  for (const kind of kinds) {
    try {
      const declaration = access[kind];
      let allowed = answers.get(declaration);
      if (allowed === undefined) {
        allowed = (await deps.authorisation.check(context, declaration)).allowed;
        answers.set(declaration, allowed);
      }
      if (allowed) permitted.push(kind);
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
  return permitted;
}

/**
 * The scope of a reader: a seller-side member sees their own seller's notices, an admin the
 * Market's admin notices, each only of the kinds whose permission they hold now. Refused for
 * anyone else (a customer, the system actor, an anonymous caller).
 */
export async function readerScope(
  deps: InAppNoticeDependencies,
  context: CallContext,
): Promise<Result<NoticeScope, { readonly code: 'access.denied' }>> {
  const { actor } = context;
  if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
  const since = retentionEdge(deps.clock);
  if (actor.population === 'seller' && actor.sellerId !== null) {
    return ok({
      owner: { audience: 'seller', sellerId: actor.sellerId },
      accountId: actor.accountId,
      kinds: await permittedKinds(deps, context, SELLER_NOTICE_KINDS, SELLER_KIND_ACCESS),
      since,
    });
  }
  if (actor.population === 'admin') {
    return ok({
      owner: { audience: 'admin' },
      accountId: actor.accountId,
      kinds: await permittedKinds(deps, context, ADMIN_NOTICE_KINDS, ADMIN_KIND_ACCESS),
      since,
    });
  }
  return err({ code: 'access.denied' });
}

/**
 * The kinds of a scope whose newest unread notice the bell's count carries (to ring): a seller's
 * orders only (plan 6b), every admin kind.
 */
export function ringingKinds(scope: NoticeScope): readonly string[] {
  if (scope.owner.audience === 'admin') return scope.kinds;
  return scope.kinds.filter((kind) => (SELLER_RINGING_KINDS as readonly string[]).includes(kind));
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

/**
 * Adds the customer's short name to each seller order notice of a page, with ONE ordering call
 * for the page, after the read unit has closed. Advisory: a refusal or a failure is logged
 * (counts and codes only, never a name) and leaves every name null; it never fails the list.
 */
export async function withCustomerNames(
  deps: InAppNoticeDependencies,
  context: CallContext,
  views: readonly NoticeView[],
): Promise<readonly ListedNoticeView[]> {
  const sellerOrderIds = [
    ...new Set(
      views
        .filter((view) => view.kind === SELLER_ORDER_PAID)
        .map((view) => (view.params as SellerOrderPaidParams).sellerOrderId),
    ),
  ];
  let names: ReadonlyMap<string, string> = new Map();
  if (sellerOrderIds.length > 0) {
    try {
      const answer = await deps.ordering.sellerOrderCustomerNames(context, sellerOrderIds);
      if (answer.ok) {
        names = new Map(answer.value.map((row) => [row.sellerOrderId, row.customerShortName]));
      } else {
        logger.warn({
          msg: 'notifications.customer-names-refused',
          code: answer.error.code,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
        });
      }
    } catch (error) {
      logger.error({
        msg: 'notifications.customer-names-failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    }
  }
  return views.map((view) => ({
    ...view,
    customerShortName:
      view.kind === SELLER_ORDER_PAID
        ? (names.get((view.params as SellerOrderPaidParams).sellerOrderId) ?? null)
        : null,
  }));
}
