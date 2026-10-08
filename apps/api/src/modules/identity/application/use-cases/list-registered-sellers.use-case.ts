import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { RegisteredSeller, SellerAccessRepository } from '../ports/seller-access.repository';

/** The largest page (sellers design R-6; the backfill pages by id). */
export const MAX_SELLER_PAGE = 500;

export interface ListRegisteredSellersInput {
  /** The last id of the previous page; absent or null for the first page. */
  readonly after?: string | null;
  readonly limit: number;
}

export interface RegisteredSellerPage {
  readonly items: readonly RegisteredSeller[];
  /** The `after` of the next page, or null when this page was the last. */
  readonly next: Id<'Seller'> | null;
}

export type ListRegisteredSellersFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ListRegisteredSellersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerAccess: SellerAccessRepository;
}

/**
 * The id paging of sellers design R-6, the part its slice 1 needs (identity design 8.1; slice 5):
 * the registered sellers of the Market, by id, with their `origin`, for the `sellers` backfill
 * that creates missing files. Rule `system`: never over HTTP, never for an admin. The admin list
 * by state with counts per state, under `identity.seller-access.view`, waits for the registry
 * (slice 8a) and the admin seller list (sellers slice 6). One read-only unit per page.
 */
export class ListRegisteredSellers extends UseCase<
  ListRegisteredSellersInput,
  RegisteredSellerPage,
  ListRegisteredSellersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-registered-sellers',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ListRegisteredSellers');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListRegisteredSellersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListRegisteredSellersInput,
  ): Promise<Result<RegisteredSellerPage, ListRegisteredSellersFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { limit } = input;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SELLER_PAGE) {
      return err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
    }
    let after: Id<'Seller'> | null = null;
    if (input.after !== undefined && input.after !== null) {
      const parsed = parseId<'Seller'>(input.after);
      if (!parsed.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'after', code: 'format' }] });
      }
      after = parsed.value;
    }
    const { market } = context;
    // One row more than the page tells whether another page exists, so the last page, even one
    // exactly `limit` long, answers `next: null` (Sajad gap 3).
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.sellerAccess.listRegistered(market, after, limit + 1)),
      { readOnly: true },
    );
    if (!read.ok) {
      // Fails closed (an empty last page), but never silently (Mojtaba, slice 5 review).
      this.#logger.warn({
        msg: 'identity.list-registered-sellers.read-failed',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return ok({ items: [], next: null });
    }
    const more = read.value.length > limit;
    const items = more ? read.value.slice(0, limit) : read.value;
    return ok({ items, next: more ? items[items.length - 1]!.sellerId : null });
  }
}
