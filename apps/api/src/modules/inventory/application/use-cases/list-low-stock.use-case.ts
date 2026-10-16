import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { INVENTORY_STOCK_VIEW } from '../../contracts/permissions';
import type { LowStockPage, OfferStockReader } from '../ports/offer-stock.reader';
import type { SellUnitLabel, SellUnitLabelsSource } from '../ports/sell-unit-labels';
import { sellerOf, validationFailed, type ValidationFailed } from '../source-use-case-support';

export const DEFAULT_LOW_STOCK_PAGE = 25;
export const MAX_LOW_STOCK_PAGE = 100;

export interface ListLowStockInput {
  /** `low` or `out`; absent keeps both. */
  readonly status?: unknown;
  readonly limit?: unknown;
  /** The `nextCursor` of the previous page. */
  readonly cursor?: unknown;
}

/** One sell unit of the seller that is running low or out of stock. */
export interface LowStockItemView {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly status: 'low' | 'out';
  /** Set for `low` only. */
  readonly onlyLeft: number | null;
  readonly changedAt: Temporal.Instant;
  /** The published names; null when unpublished or when the lookup failed. */
  readonly productName: string | null;
  readonly variantLabel: string | null;
}

export interface LowStockPageView {
  readonly items: readonly LowStockItemView[];
  readonly nextCursor: string | null;
}

export type ListLowStockFailure = ValidationFailed | { readonly code: 'access.denied' };

export interface ListLowStockDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offerStock: OfferStockReader;
  readonly labels: SellUnitLabelsSource;
}

const STATUSES = ['low', 'out'] as const;

/** A page cursor is `<changed-at ms>.<signal id>`: opaque to callers, checked on the way in. */
const encodeCursor = (changedAt: Temporal.Instant, id: string): string =>
  `${changedAt.epochMilliseconds}.${id}`;

function decodeCursor(value: unknown): LowStockPage['after'] | undefined {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId<'AvailabilitySignal'>(match[2]!);
  if (match === null || id === null || !id.ok) return undefined;
  return { changedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value };
}

/**
 * `inventory.list-low-stock` (seller dashboard): the acting seller's sell units whose published
 * availability is `low` or `out`, most recently changed first, from the availability signals
 * (one per sell unit, the maximum over its locations). A sell unit whose stock items are all
 * retired (deleted Offer or retired Variant) is left out: nothing is left to restock. The page
 * can hold fewer rows than `limit` for that reason; `nextCursor` is null only at the end.
 * Read-only: one read-only unit (ADR-0025); the names come after it from catalog's published
 * labels, and a failed lookup leaves them null.
 */
export class ListLowStock extends UseCase<
  ListLowStockInput,
  LowStockPageView,
  ListLowStockFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.list-low-stock',
    rule: { kind: 'permissions', allOf: [INVENTORY_STOCK_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ListLowStock');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListLowStockDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListLowStockInput,
  ): Promise<Result<LowStockPageView, ListLowStockFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const fields: { path: string; code: string }[] = [];
    let status: 'low' | 'out' | null = null;
    if (input?.status !== undefined) {
      if (STATUSES.includes(input.status as 'low')) status = input.status as 'low' | 'out';
      else fields.push({ path: 'status', code: 'value' });
    }
    let limit = DEFAULT_LOW_STOCK_PAGE;
    if (input?.limit !== undefined) {
      if (
        typeof input.limit === 'number' &&
        Number.isSafeInteger(input.limit) &&
        input.limit >= 1 &&
        input.limit <= MAX_LOW_STOCK_PAGE
      ) {
        limit = input.limit;
      } else fields.push({ path: 'limit', code: 'range' });
    }
    let after: LowStockPage['after'] = null;
    if (input?.cursor !== undefined) {
      const decoded = decodeCursor(input.cursor);
      if (decoded === undefined) fields.push({ path: 'cursor', code: 'format' });
      else after = decoded;
    }
    if (fields.length > 0) return validationFailed(fields);

    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const signals = await this.deps.offerStock.listLowStock(market, sellerId, status, {
          limit: limit + 1,
          after,
        });
        const page = signals.slice(0, limit);
        const live = await this.deps.offerStock.liveSellUnits(market, sellerId, page);
        const last = page[page.length - 1];
        return ok({
          signals: page.filter((signal) => live.has(`${signal.offerId}:${signal.variantId}`)),
          nextCursor:
            signals.length > limit && last !== undefined
              ? encodeCursor(last.changedAt, last.id)
              : null,
        });
      },
      { readOnly: true },
    );
    if (!read.ok) throw new Error('inventory.list-low-stock: a read-only unit failed');
    const { signals, nextCursor } = read.value;

    let labels: ReadonlyMap<string, SellUnitLabel> = new Map();
    if (signals.length > 0) {
      try {
        labels = await this.deps.labels.labelsOf(context, signals);
      } catch {
        this.#logger.warn({
          msg: 'inventory.list-low-stock.labels-failed',
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
    }
    this.#logger.log({
      msg: 'inventory.list-low-stock.done',
      items: signals.length,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({
      items: signals.map((signal) => {
        const label = labels.get(`${signal.offerId}:${signal.variantId}`);
        return {
          offerId: signal.offerId,
          variantId: signal.variantId,
          status: signal.status,
          onlyLeft: signal.onlyLeft,
          changedAt: signal.changedAt,
          productName: label?.productName ?? null,
          variantLabel: label?.variantLabel ?? null,
        };
      }),
      nextCursor,
    });
  }
}
