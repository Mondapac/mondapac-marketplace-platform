import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import { productIdOf } from '../products/product-lifecycle';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { AdminProductsReader, ProductState } from '../ports/admin-products.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { AdminProductPause } from './admin-product-pause.use-case';
import type { AdminProductResume } from './admin-product-resume.use-case';
import type { AdminProductWithdraw } from './admin-product-withdraw.use-case';
import {
  filterOfSelector,
  parseSelector,
  type ProductSelector,
} from './admin-products-list.use-case';
import type { PlatformProductRetire } from './platform-product-retire.use-case';

/** The actions of the Products page's Bulk action menu: Deactivate, Activate and Delete. */
export const BULK_ACTIONS = ['pause', 'resume', 'delete'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/** Explicit ids per request (catalog design 9.2c; the design asks for at most 200). */
export const BULK_MAX_IDS = 200;
/** Products a selector may resolve to; more is refused whole, the admin narrows the filter. */
export const BULK_MAX_SELECTED = 2000;
/** Products worked on at the same time (each is its own unit). */
const BULK_CONCURRENCY = 4;

export type BulkOutcome = 'done' | 'skipped' | 'failed';

/** Why a product was skipped or failed: a stable code, never text. */
export interface BulkItemResult {
  readonly productId: string;
  readonly outcome: BulkOutcome;
  readonly reason?: string;
}

export interface BulkCounts {
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface AdminProductsBulkInput {
  readonly action?: unknown;
  readonly productIds?: unknown;
  readonly selector?: unknown;
  readonly confirmOfferCount?: unknown;
  readonly dryRun?: unknown;
}

export interface AdminProductsBulkOutput {
  readonly action: BulkAction;
  readonly dryRun: boolean;
  /** Products the request resolved to. */
  readonly requested: number;
  /** Products the action would change, or changed (dry run: before; run: `counts.done`). */
  readonly eligible: number;
  /**
   * `delete` only: the Offers of the PLATFORM products that would be retired. The confirmation
   * carries this number (CAT-48); a Delete without it, or with another, is refused whole.
   */
  readonly confirmOfferCount: number;
  /** `delete` only: the Offers of every product the action would end or retire. */
  readonly affectedOfferCount: number;
  readonly counts: BulkCounts;
  /** Every product, in the order given (selector: newest change first). Empty on a dry run. */
  readonly results: readonly BulkItemResult[];
}

export type AdminProductsBulkFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number }
  | { readonly code: 'retire.count-changed'; readonly currentCount: number }
  | ValidationFailure;

export interface AdminProductsBulkDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminProductsReader: AdminProductsReader;
  readonly policy: CatalogMarketPolicy;
  readonly pause: AdminProductPause;
  readonly resume: AdminProductResume;
  readonly withdraw: AdminProductWithdraw;
  readonly retire: PlatformProductRetire;
}

const KEYS = new Set(['action', 'productIds', 'selector', 'confirmOfferCount', 'dryRun']);
const SELECTOR_KEYS = new Set([
  'view',
  'q',
  'scope',
  'status',
  'categoryId',
  'typeCode',
  'sellerId',
]);

/** Refusals of one product that mean "nothing to do in this state": the item is skipped. */
const SKIPPED = new Set([
  'product.not-published',
  'product.already-paused',
  'product.not-paused',
  'product.not-withdrawable',
  'product.platform-only',
  'product.seller-only',
  'access.denied',
]);

/** Whether the action would change a product in this state (the same guards as the domain). */
function eligibleFor(action: BulkAction, state: ProductState): boolean {
  switch (action) {
    case 'pause':
      return state.status === 'published' && !state.paused;
    case 'resume':
      return state.paused;
    case 'delete':
      return state.scope === 'PLATFORM'
        ? state.status === 'published'
        : state.status === 'published' || state.status === 'unpublished';
  }
}

/** Runs `work` over `items` with at most `limit` in flight; results keep the order of `items`. */
async function inPool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * `admin-products.bulk` (catalog design 9.2c; the Bulk action menu of the Products page): Deactivate
 * (`pause`, 4.1a), Activate (`resume`) and Delete (`withdraw` a SELLER product, `retire` a PLATFORM
 * one, 4.1) over many products. The request names its products by explicit `productIds` (at most
 * {@link BULK_MAX_IDS}) or by a `selector` (`view`, `q` and the list's filters: "Select all N
 * products in this filter", resolved here and capped at {@link BULK_MAX_SELECTED}); an oversized
 * request is refused whole with `batch.too-large`, and any id that is not a product of the
 * caller's Market refuses the whole request as `product.not-found`, byte-identically (the SL 7.3
 * pattern of bulk approve). Rule: the key `catalog.product.view`; each product then runs through
 * the single use case of its action with the caller's own context, so that use case's key is
 * checked for every product (a product the admin may not act on is skipped as `access.denied`; all
 * of them denied refuses the request). **Each product is its own unit; a product that fails never
 * undoes another.** The answer holds a result per product (`done`, `skipped` with a state reason
 * such as `product.already-paused`, or `failed` with the code that stopped it) and the counts.
 *
 * Delete of PLATFORM products carries the count confirmation (CAT-48): `confirmOfferCount` must
 * equal the Offers on the PLATFORM products that would be retired, else the whole request is
 * refused with `retire.count-changed` and the current count (and each product's own unit checks
 * its own count again). `dryRun: true` changes nothing and answers `eligible`,
 * `confirmOfferCount` and `affectedOfferCount`, which the confirm dialog shows.
 */
export class AdminProductsBulk extends UseCase<
  AdminProductsBulkInput,
  AdminProductsBulkOutput,
  AdminProductsBulkFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-products-bulk',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  readonly #logger = new Logger('AdminProductsBulk');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminProductsBulkDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminProductsBulkInput,
  ): Promise<Result<AdminProductsBulkOutput, AdminProductsBulkFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.admin-products-bulk',
      code: result.ok ? (result.value.dryRun ? 'dry-run' : 'ok') : result.error.code,
      ...(result.ok
        ? {
            action: result.value.action,
            requested: result.value.requested,
            done: result.value.counts.done,
            skipped: result.value.counts.skipped,
            failed: result.value.counts.failed,
          }
        : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: AdminProductsBulkInput,
  ): Promise<Result<AdminProductsBulkOutput, AdminProductsBulkFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const request = this.#parse(input);
    if (!request.ok) return request;
    const { action, dryRun, confirm } = request.value;
    const { deps } = this;
    let locale: string;
    try {
      locale = deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }

    // Resolve the products: explicit ids, or the selector's matches.
    const resolved = await deps.unitOfWork.run<
      { readonly ids: readonly Id<'Product'>[]; readonly states: readonly ProductState[] },
      AdminProductsBulkFailure
    >(
      market,
      async () => {
        const reader = deps.adminProductsReader;
        let ids: readonly Id<'Product'>[];
        if (request.value.ids !== null) {
          const found = await reader.existing(market, request.value.ids);
          if (request.value.ids.some((id) => !found.has(id))) {
            return err({ code: 'product.not-found' as const });
          }
          ids = request.value.ids;
        } else {
          const filter = filterOfSelector(
            request.value.selector!,
            request.value.selector!.view,
            locale,
          );
          ids = await reader.ids(market, filter, BULK_MAX_SELECTED + 1);
          if (ids.length > BULK_MAX_SELECTED) {
            const [total] = await reader.counts(market, [filter]);
            return err({
              code: 'batch.too-large' as const,
              max: BULK_MAX_SELECTED,
              ...(total === undefined ? {} : { total }),
            });
          }
          if (ids.length === 0) return invalid('selector', 'empty');
        }
        return ok({ ids, states: await reader.states(market, ids) });
      },
      { readOnly: true },
    );
    if (!resolved.ok) {
      return err(resolved.error);
    }
    const { ids, states } = resolved.value;
    const stateOf = new Map(states.map((state) => [state.productId as string, state]));

    const eligible = ids.filter((id) => {
      const state = stateOf.get(id);
      return state !== undefined && eligibleFor(action, state);
    });
    const retiring =
      action === 'delete'
        ? eligible.map((id) => stateOf.get(id)!).filter((state) => state.scope === 'PLATFORM')
        : [];
    const confirmOfferCount = retiring.reduce((sum, state) => sum + state.offerCount, 0);
    const affectedOfferCount =
      action === 'delete'
        ? eligible.reduce((sum, id) => sum + (stateOf.get(id)?.offerCount ?? 0), 0)
        : 0;

    if (dryRun) {
      return ok({
        action,
        dryRun: true,
        requested: ids.length,
        eligible: eligible.length,
        confirmOfferCount,
        affectedOfferCount,
        counts: { done: 0, skipped: 0, failed: 0 },
        results: [],
      });
    }
    if (retiring.length > 0) {
      if (confirm === null) return invalid('confirmOfferCount', 'required');
      if (confirm !== confirmOfferCount) {
        return err({ code: 'retire.count-changed', currentCount: confirmOfferCount });
      }
    }

    const results = await inPool(ids, BULK_CONCURRENCY, (id) =>
      this.#one(context, action, id, stateOf.get(id)),
    );
    const counts: BulkCounts = {
      done: results.filter((r) => r.outcome === 'done').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
    };
    // Every product refused for the key: the admin may not do this at all.
    if (results.length > 0 && results.every((r) => r.reason === 'access.denied')) {
      return err({ code: 'access.denied' });
    }
    return ok({
      action,
      dryRun: false,
      requested: ids.length,
      eligible: counts.done,
      confirmOfferCount,
      affectedOfferCount,
      counts,
      results,
    });
  }

  /** One product through its single use case: its own unit, its own key. */
  async #one(
    context: CallContext,
    action: BulkAction,
    id: Id<'Product'>,
    state: ProductState | undefined,
  ): Promise<BulkItemResult> {
    const { deps } = this;
    const productId = id as string;
    if (state === undefined) return { productId, outcome: 'failed', reason: 'product.not-found' };
    let answer: Result<unknown, { readonly code: string }>;
    try {
      switch (action) {
        case 'pause':
          answer = await deps.pause.execute(context, { productId });
          break;
        case 'resume':
          answer = await deps.resume.execute(context, { productId });
          break;
        case 'delete':
          answer =
            state.scope === 'PLATFORM'
              ? await deps.retire.execute(context, {
                  productId,
                  confirmOfferCount: state.offerCount,
                })
              : await deps.withdraw.execute(context, { productId });
          break;
      }
    } catch {
      return { productId, outcome: 'failed', reason: 'access.unavailable' };
    }
    if (answer.ok) return { productId, outcome: 'done' };
    const { code } = answer.error;
    return SKIPPED.has(code)
      ? { productId, outcome: 'skipped', reason: code }
      : { productId, outcome: 'failed', reason: code };
  }

  #parse(input: AdminProductsBulkInput): Result<
    {
      readonly action: BulkAction;
      readonly dryRun: boolean;
      readonly confirm: number | null;
      readonly ids: readonly Id<'Product'>[] | null;
      readonly selector: ProductSelector | null;
    },
    AdminProductsBulkFailure
  > {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('body', 'type');
    }
    const record = input as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!KEYS.has(key)) return invalid(key, 'unknown');
    const action = record['action'];
    if (typeof action !== 'string' || !(BULK_ACTIONS as readonly string[]).includes(action)) {
      return invalid('action', 'value');
    }
    const dryRun = record['dryRun'];
    if (dryRun !== undefined && typeof dryRun !== 'boolean') return invalid('dryRun', 'type');
    const confirm = record['confirmOfferCount'];
    if (
      confirm !== undefined &&
      (typeof confirm !== 'number' || !Number.isSafeInteger(confirm) || confirm < 0)
    ) {
      return invalid('confirmOfferCount', 'range');
    }
    const hasIds = record['productIds'] !== undefined;
    const hasSelector = record['selector'] !== undefined;
    if (hasIds === hasSelector) return invalid(hasIds ? 'selector' : 'productIds', 'exclusive');

    let ids: Id<'Product'>[] | null = null;
    let selector: ProductSelector | null = null;
    if (hasIds) {
      const list = record['productIds'];
      if (!Array.isArray(list) || list.length === 0) return invalid('productIds', 'length');
      if (list.length > BULK_MAX_IDS) return err({ code: 'batch.too-large', max: BULK_MAX_IDS });
      const parsed: Id<'Product'>[] = [];
      for (const value of list as unknown[]) {
        const id = productIdOf(value);
        if (id === null) return invalid('productIds', 'format');
        parsed.push(id);
      }
      if (new Set(parsed).size !== parsed.length) return invalid('productIds', 'duplicate');
      ids = parsed;
    } else {
      const raw = record['selector'];
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return invalid('selector', 'type');
      }
      for (const key of Object.keys(raw)) {
        if (!SELECTOR_KEYS.has(key)) return invalid(`selector.${key}`, 'unknown');
      }
      const parsed = parseSelector(raw as Record<string, unknown>, 'selector.');
      if (!parsed.ok) return parsed;
      selector = parsed.value;
    }
    return ok({
      action: action as BulkAction,
      dryRun: dryRun === true,
      confirm: confirm === undefined ? null : confirm,
      ids,
      selector,
    });
  }
}
