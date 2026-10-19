import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  ADMIN_NOTICES_PER_MARKET,
  ADMIN_PRICE_HOLD_OPENED,
  ADMIN_PRODUCT_REVISION_SUBMITTED,
  ADMIN_SELLER_CERTIFICATE_SUBMITTED,
  ADMIN_SELLER_FILE_SUBMITTED,
  type CERTIFICATE_SUBMISSIONS,
  type HOLD_DIRECTIONS,
  type SELLER_FILE_KINDS,
} from '../../domain/in-app-notice';
import type { InAppNoticeDependencies } from '../in-app-notice-flow';

/** What waits for review, as each event's payload says it (ids and enums only). */
export type AdminReviewItem =
  | {
      readonly kind: typeof ADMIN_SELLER_CERTIFICATE_SUBMITTED;
      readonly sellerId: string;
      readonly sellerCertificationId: string;
      readonly submission: (typeof CERTIFICATE_SUBMISSIONS)[number];
    }
  | {
      readonly kind: typeof ADMIN_PRODUCT_REVISION_SUBMITTED;
      readonly productId: string;
      readonly revisionId: string;
      readonly scope: 'platform' | 'seller';
    }
  | {
      readonly kind: typeof ADMIN_SELLER_FILE_SUBMITTED;
      readonly sellerId: string;
      readonly fileKind: (typeof SELLER_FILE_KINDS)[number];
    }
  | {
      readonly kind: typeof ADMIN_PRICE_HOLD_OPENED;
      readonly recordId: string;
      readonly offerId: string;
      readonly direction: (typeof HOLD_DIRECTIONS)[number];
    };

export interface RecordAdminReviewNoticeInput {
  readonly delivery: EventDelivery;
  readonly item: AdminReviewItem;
}

export type RecordAdminReviewNoticeOutput =
  | { readonly code: 'notices.recorded'; readonly notices: number }
  | { readonly code: 'notices.skipped'; readonly reason: 'revision.not-pending' }
  | { readonly code: 'notices.already-handled' };

export type RecordAdminReviewNoticeFailure = { readonly code: 'access.denied' };

/** The stored params of an item: its ids and enums, never a name. */
function paramsOf(item: AdminReviewItem): Readonly<Record<string, string>> {
  switch (item.kind) {
    case ADMIN_SELLER_CERTIFICATE_SUBMITTED:
      return {
        sellerId: item.sellerId,
        sellerCertificationId: item.sellerCertificationId,
        submission: item.submission,
      };
    case ADMIN_PRODUCT_REVISION_SUBMITTED:
      return { productId: item.productId, revisionId: item.revisionId };
    case ADMIN_SELLER_FILE_SUBMITTED:
      return { sellerId: item.sellerId, fileKind: item.fileKind };
    case ADMIN_PRICE_HOLD_OPENED:
      return { recordId: item.recordId, offerId: item.offerId, direction: item.direction };
  }
}

/**
 * The admins' review notice (in-app notifications package 3): something now waits in a review
 * queue of the Market, so one admin notice is written, shown to each admin who holds the kind's
 * permission when they read. From the subscriptions on `certification.seller-certification-
 * submitted.v1`, `catalog.product-revision-submitted.v1`, `sellers.business-file-submitted.v1` and
 * `pricing.price-hold-opened.v1`. A product revision makes a notice only while it is still
 * pending (a seller revision may publish at once, and a platform one is the admins' own); this is
 * read through catalog before the unit. Written in the inbox unit, so a repeated delivery adds
 * nothing; the Market's oldest admin notices of the same kind beyond the cap leave in the same
 * unit (a cap per kind, so a flood of one queue never pushes another queue's notices out). Rule `system`.
 */
export class RecordAdminReviewNotice extends UseCase<
  RecordAdminReviewNoticeInput,
  RecordAdminReviewNoticeOutput,
  RecordAdminReviewNoticeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.record-admin-review-notice',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RecordAdminReviewNotice');

  constructor(
    gate: UseCaseGate,
    private readonly deps: InAppNoticeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RecordAdminReviewNoticeInput,
  ): Promise<Result<RecordAdminReviewNoticeOutput, RecordAdminReviewNoticeFailure>> {
    const { item } = input;
    let pending = true;
    if (item.kind === ADMIN_PRODUCT_REVISION_SUBMITTED) {
      if (item.scope === 'platform') pending = false;
      else {
        // Read before the unit (P 3.1 row 5): the product is catalog's, through its facade.
        const revisionId = item.revisionId as Id<'ProductRevision'>;
        const answer = await this.deps.catalog.pendingProductRevisions(context, [
          { productId: item.productId as Id<'Product'>, revisionId },
        ]);
        if (!answer.ok) {
          if (answer.error.code === 'access.denied') return err({ code: 'access.denied' });
          throw new Error(
            `admin-review-notice: the revision could not be read: ${answer.error.code}`,
          );
        }
        pending = answer.value.has(revisionId);
      }
    }
    let output: RecordAdminReviewNoticeOutput;
    if (!pending) {
      const marked = await this.deps.unitOfWork.runOnce(context.market, input.delivery, () =>
        Promise.resolve(ok(undefined)),
      );
      if (!marked.ok) throw new Error('admin-review-notice: the inbox unit failed');
      output = marked.value.handled
        ? { code: 'notices.skipped', reason: 'revision.not-pending' }
        : { code: 'notices.already-handled' };
    } else {
      const notice = {
        id: this.deps.ids.next<'InAppNotice'>(),
        owner: { audience: 'admin' as const },
        kind: item.kind,
        params: paramsOf(item),
        createdAt: this.deps.clock.now(),
      };
      const written = await this.deps.unitOfWork.runOnce(
        context.market,
        input.delivery,
        async () => {
          await this.deps.notices.add(context.market, [notice]);
          await this.deps.notices.trim(
            context.market,
            { audience: 'admin' },
            ADMIN_NOTICES_PER_MARKET,
            notice.kind,
          );
          return ok(1);
        },
      );
      if (!written.ok) throw new Error('admin-review-notice: the inbox unit failed');
      output = written.value.handled
        ? { code: 'notices.recorded', notices: written.value.value }
        : { code: 'notices.already-handled' };
    }
    // Ids and codes only.
    this.#logger.log({
      msg: `notifications.${output.code}`,
      kind: item.kind,
      ...('notices' in output ? { notices: output.notices } : {}),
      ...('reason' in output ? { reason: output.reason } : {}),
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
