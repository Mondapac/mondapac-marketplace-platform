import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  NOTICES_PER_SELLER,
  parseNoticeParams,
  type SELLER_ORDER_PAID,
  type SellerNoticeKind,
} from '../../domain/in-app-notice';
import type { InAppNoticeDependencies } from '../in-app-notice-flow';

/**
 * Whose notice it is, as the event says it: the seller itself, or an Offer or a product of the
 * seller, whose owner is read through catalog.
 */
export type SellerNoticeOwnerRef =
  | { readonly by: 'seller'; readonly sellerId: string }
  | { readonly by: 'offer'; readonly offerId: string }
  | { readonly by: 'product'; readonly productId: string };

/** One seller notice of package 4: its kind, whose it is, and its params (ids, enums, counts). */
export interface SellerNoticeItem {
  readonly kind: Exclude<SellerNoticeKind, typeof SELLER_ORDER_PAID>;
  readonly owner: SellerNoticeOwnerRef;
  readonly params: Readonly<Record<string, string | number>>;
}

export interface RecordSellerNoticeInput {
  readonly delivery: EventDelivery;
  readonly item: SellerNoticeItem;
}

export type RecordSellerNoticeOutput =
  | { readonly code: 'notices.recorded'; readonly notices: number }
  | { readonly code: 'notices.skipped'; readonly reason: 'owner.unknown' }
  | { readonly code: 'notices.already-handled' };

export type RecordSellerNoticeFailure = { readonly code: 'access.denied' };

/**
 * The sellers' other in-app notices (in-app notifications package 4): low stock, a certificate's
 * review, expiry or end, an issuer request's answer, an Offer's or a product's review, a tag
 * change, an image take-down, a held price's decision and the seller's access. One notice for
 * the seller the item belongs to, shown to each member who holds the kind's permission when
 * reading. When the event names an Offer or a product only, its owner is read through catalog
 * before the unit; a PLATFORM product, or an item catalog no longer knows, makes no notice.
 * Written in the inbox unit, so a repeated delivery adds nothing; the seller's oldest notices of
 * the same kind beyond the cap leave in the same unit. Rule `system`.
 */
export class RecordSellerNotice extends UseCase<
  RecordSellerNoticeInput,
  RecordSellerNoticeOutput,
  RecordSellerNoticeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.record-seller-notice',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RecordSellerNotice');

  constructor(
    gate: UseCaseGate,
    private readonly deps: InAppNoticeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RecordSellerNoticeInput,
  ): Promise<Result<RecordSellerNoticeOutput, RecordSellerNoticeFailure>> {
    const { item } = input;
    // The event's payload was checked against its schema; a mismatch here is a wiring bug.
    if (parseNoticeParams(item.kind, item.params) === null) {
      throw new Error(`seller-notice: the params do not fit the kind ${item.kind}`);
    }
    const owner = await this.ownerOf(context, item.owner);
    if (!owner.ok) return owner;
    const sellerId = owner.value;
    let output: RecordSellerNoticeOutput;
    if (sellerId === null) {
      const marked = await this.deps.unitOfWork.runOnce(context.market, input.delivery, () =>
        Promise.resolve(ok(undefined)),
      );
      if (!marked.ok) throw new Error('seller-notice: the inbox unit failed');
      output = marked.value.handled
        ? { code: 'notices.skipped', reason: 'owner.unknown' }
        : { code: 'notices.already-handled' };
    } else {
      const notice = {
        id: this.deps.ids.next<'InAppNotice'>(),
        owner: { audience: 'seller' as const, sellerId },
        kind: item.kind,
        params: item.params,
        createdAt: this.deps.clock.now(),
      };
      const written = await this.deps.unitOfWork.runOnce(
        context.market,
        input.delivery,
        async () => {
          await this.deps.notices.add(context.market, [notice]);
          await this.deps.notices.trim(context.market, notice.owner, NOTICES_PER_SELLER, item.kind);
          return ok(1);
        },
      );
      if (!written.ok) throw new Error('seller-notice: the inbox unit failed');
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

  /** The seller the item belongs to; null when catalog does not know it as a seller's item. */
  private async ownerOf(
    context: CallContext,
    ref: SellerNoticeOwnerRef,
  ): Promise<Result<Id<'Seller'> | null, RecordSellerNoticeFailure>> {
    if (ref.by === 'seller') return ok(ref.sellerId as Id<'Seller'>);
    // The owner now, not at the event: Offers and SELLER products never change owner today. A
    // future ownership transfer must carry the seller on its events instead.
    // Read before the unit (P 3.1 row 5): Offers and products are catalog's, through its facade.
    const answer =
      ref.by === 'offer'
        ? await this.deps.catalog
            .offerSellUnits(context, [ref.offerId as Id<'Offer'>])
            .then((result) =>
              result.ok
                ? ok(result.value.get(ref.offerId as Id<'Offer'>)?.sellerId ?? null)
                : result,
            )
        : await this.deps.catalog
            .sellerProductOwners(context, [ref.productId as Id<'Product'>])
            .then((result) =>
              result.ok ? ok(result.value.get(ref.productId as Id<'Product'>) ?? null) : result,
            );
    if (answer.ok) return answer;
    if (answer.error.code === 'access.denied') return err({ code: 'access.denied' });
    throw new Error(`seller-notice: the owner could not be read: ${answer.error.code}`);
  }
}
