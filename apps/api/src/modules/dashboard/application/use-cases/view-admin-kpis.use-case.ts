import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../../commission-payouts';
import { ORDERING_ORDER_VIEW } from '../../../ordering';
import type { Id } from '@mondapac/shared-kernel';
import {
  CATALOG_PRODUCT_VIEW,
  type CatalogIndexFacade,
  type CatalogWorkQueueFacade,
} from '../../../catalog';
import {
  SELLERS_SELLER_VIEW,
  type SellersFacade,
  type SellersWorkQueueFacade,
} from '../../../sellers';
import type {
  FinanceAnswer,
  KpiFailure,
  OperationsAnswer,
  PeriodId,
  PeriodRefused,
  PeriodRequest,
  ReportingKpiFacade,
  TopCategoriesAnswer,
  TopSellersAnswer,
} from '../../../reporting';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../../platform/work-queue/work-queue-count';
import type { ViewerPermissions } from '../ports/viewer-permissions';

/** How long one KPI read may take before its section answers `error` (design section 6). */
export const KPI_TIMEOUT_MS = 1_500;

/** One section of the KPI answer: its numbers, or `error` when it failed or took too long. */
export type KpiSection<T> =
  { readonly status: 'ok'; readonly value: T } | { readonly status: 'error' };

/** One row of the top-sellers table, with the seller's public store name (null: not known). */
export interface NamedTopSeller {
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly gmvWithTax: bigint;
  readonly ordersPaid: number;
  readonly onTimeRateBp: number | null;
  readonly refundRateBp: number | null;
}

export interface NamedTopSellers {
  readonly period: TopSellersAnswer['period'];
  readonly currency: string;
  readonly rows: readonly NamedTopSeller[];
}

/** One row of the top-categories list, with the category's name (null: not known). */
export interface NamedTopCategory {
  readonly categoryId: string;
  readonly name: string | null;
  readonly salesWithTax: bigint;
  readonly orders: number;
}

export interface NamedTopCategories {
  readonly period: TopCategoriesAnswer['period'];
  readonly currency: string;
  readonly rows: readonly NamedTopCategory[];
}

/** A count the health card shows: its number, or `error` when its owner failed or was slow. */
export type HealthCount =
  { readonly status: 'ok'; readonly count: number } | { readonly status: 'error' };

/**
 * The marketplace health numbers that need no new owner query: the owners' work-queue counts. A
 * metric the viewer holds no key for is null; the other still answers.
 */
export interface MarketHealth {
  /** Offer certification tags still active after their certificate lapsed (an incident). */
  readonly uncertifiedListings: HealthCount | null;
  /** Sellers in the health queue. */
  readonly sellersAtRisk: HealthCount | null;
}

export interface AdminKpisAnswer {
  readonly generatedAt: Temporal.Instant;
  /** The preset asked for, or `custom` for a range of the admin's choice. */
  readonly period: PeriodId | 'custom';
  /** Null when the viewer does not hold `ordering.order.view` (the section is left out). */
  readonly operations: KpiSection<OperationsAnswer> | null;
  /** Null when the viewer does not hold `commission-payouts.settlement.view`. */
  readonly finance: KpiSection<FinanceAnswer> | null;
  /** Null without `commission-payouts.settlement.view` (it shows each seller's money). */
  readonly topSellers: KpiSection<NamedTopSellers> | null;
  /** Null without `commission-payouts.settlement.view` (it shows money). */
  readonly topCategories: KpiSection<NamedTopCategories> | null;
  /** Null when the viewer holds neither `catalog.product.view` nor `sellers.seller.view`. */
  readonly health: MarketHealth | null;
}

export interface AdminKpisDependencies {
  readonly viewer: ViewerPermissions;
  readonly reporting: ReportingKpiFacade;
  readonly sellers: Pick<SellersFacade, 'sellerSummaries'>;
  readonly catalog: Pick<CatalogIndexFacade, 'categoryTree'>;
  readonly queues: {
    readonly catalog: Pick<CatalogWorkQueueFacade, 'claimsWithoutCertificate'>;
    readonly sellers: Pick<SellersWorkQueueFacade, 'unhealthySellers'>;
  };
  readonly clock: Clock;
  /** {@link KPI_TIMEOUT_MS} outside tests. */
  readonly timeoutMs: number;
}

const logger = new Logger('AdminKpis');

/** The class name of a thrown value (never its message). */
const nameOf = (error: unknown): string => {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : 'unknown';
};

/**
 * Runs one read with a time limit. A read the owner refuses (`access.denied`) is left out like a
 * key the viewer does not hold; one that fails, takes too long or throws is `error`, so one slow
 * section never fails the other.
 */
async function section<T>(
  name: string,
  timeoutMs: number,
  read: () => Promise<Result<T, KpiFailure>>,
): Promise<KpiSection<T> | null> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), timeoutMs);
    timer.unref();
  });
  try {
    const answer = await Promise.race([read(), limit]);
    if (answer === 'timed-out') {
      logger.warn({ msg: 'dashboard.admin-kpis.section', section: name, outcome: 'timeout' });
      return { status: 'error' };
    }
    if (answer.ok) return { status: 'ok', value: answer.value };
    if (answer.error.code === 'access.denied') return null;
    logger.warn({ msg: 'dashboard.admin-kpis.section', section: name, outcome: answer.error.code });
    return { status: 'error' };
  } catch (error) {
    logger.warn({
      msg: 'dashboard.admin-kpis.section',
      section: name,
      outcome: 'threw',
      error: nameOf(error),
    });
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET dashboard/admin/kpis` (dashboards upgrade, phase 5): the admin KPI strip and trend. Rule
 * `own-resources` and a platform admin acting as themselves, like the work queue. Each section is
 * asked only when the viewer holds its key (operations: `ordering.order.view`; money:
 * `commission-payouts.settlement.view`) and its owner checks the key again. Nothing is cached
 * here: the numbers are the daily rollups, one grouped read each.
 */
export class ViewAdminKpis extends UseCase<
  { readonly period: PeriodRequest },
  AdminKpisAnswer,
  AccessDenied | PeriodRefused
> {
  static override readonly access: AccessDeclaration = {
    name: 'dashboard.view-admin-kpis',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminKpisDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly period: PeriodRequest },
  ): Promise<Result<AdminKpisAnswer, AccessDenied | PeriodRefused>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const viewer = await this.deps.viewer.describe(context);
    if (!viewer.ok) return err(viewer.error);
    if (viewer.value.population !== 'admin') return err({ code: 'access.denied' });
    // A custom range that ends after the Market's today is one 400, not a section error each. A
    // range checked now stays valid for the sections: today only moves forward.
    const checked = this.deps.reporting.resolvePeriod(context, input.period);
    if (!checked.ok) return checked;
    const held = new Set(viewer.value.permissionKeys);
    const { reporting, timeoutMs } = this.deps;
    const [operations, finance, topSellers, topCategories, health] = await Promise.all([
      held.has(ORDERING_ORDER_VIEW.key)
        ? section('operations', timeoutMs, () => reporting.marketplaceOperations(context, input))
        : null,
      held.has(COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key)
        ? section('finance', timeoutMs, () => reporting.marketplaceFinance(context, input))
        : null,
      held.has(COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key)
        ? section('top-sellers', timeoutMs, () => this.namedTopSellers(context, input))
        : null,
      held.has(COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key)
        ? section('top-categories', timeoutMs, () => this.namedTopCategories(context, input))
        : null,
      this.marketHealth(context, held),
    ]);
    return ok({
      generatedAt: this.deps.clock.now(),
      period: typeof input.period === 'string' ? input.period : 'custom',
      operations,
      finance,
      topSellers,
      topCategories,
      health,
    });
  }

  /** The health counts the viewer may see; null when they may see none. */
  private async marketHealth(
    context: CallContext,
    held: ReadonlySet<string>,
  ): Promise<MarketHealth | null> {
    const canListings = held.has(CATALOG_PRODUCT_VIEW.key);
    const canSellers = held.has(SELLERS_SELLER_VIEW.key);
    if (!canListings && !canSellers) return null;
    const { queues } = this.deps;
    const [uncertifiedListings, sellersAtRisk] = await Promise.all([
      canListings
        ? this.healthCount('uncertified-listings', (query) =>
            queues.catalog.claimsWithoutCertificate(context, query),
          )
        : null,
      canSellers
        ? this.healthCount('sellers-at-risk', (query) =>
            queues.sellers.unhealthySellers(context, query),
          )
        : null,
    ]);
    return { uncertifiedListings, sellersAtRisk };
  }

  /**
   * One owner count under the time limit. The owner checks its own key again; a refusal, a
   * failure, a slow answer or a throw is `error` (never a zero).
   */
  private async healthCount(
    name: string,
    read: (query: WorkQueueCountQuery) => Promise<Result<WorkQueueCount, AccessDenied>>,
  ): Promise<HealthCount> {
    // The signal only stops an owner before it starts its next read; a query already running is
    // not cancelled. `section()` below is what bounds the wait. `staleBefore` is `now` because
    // only `count` is used here, never the overdue figure.
    const controller = new AbortController();
    const now = this.deps.clock.now();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    timer.unref();
    const result = await section(name, this.deps.timeoutMs, () =>
      read({ now, staleBefore: now, signal: controller.signal }),
    );
    clearTimeout(timer);
    if (result === null || result.status === 'error') return { status: 'error' };
    return { status: 'ok', count: result.value.count };
  }

  /**
   * The top categories with their names from the live category tree. A category the tree does not
   * have (deleted, or the nil UUID of unreadable goods) keeps a null name; the sales still show.
   */
  private async namedTopCategories(
    context: CallContext,
    input: { readonly period: PeriodRequest },
  ): Promise<Result<NamedTopCategories, KpiFailure>> {
    const top = await this.deps.reporting.marketplaceTopCategories(context, input);
    if (!top.ok) return top;
    const names = new Map<string, string>();
    if (top.value.rows.length > 0) {
      try {
        const tree = await this.deps.catalog.categoryTree(context);
        if (tree.ok) {
          for (const category of tree.value) names.set(category.id, category.name);
        } else {
          logger.warn({ msg: 'dashboard.admin-kpis.category-names', outcome: tree.error.code });
        }
      } catch (error) {
        logger.warn({
          msg: 'dashboard.admin-kpis.category-names',
          outcome: 'threw',
          error: nameOf(error),
        });
      }
    }
    return ok({
      period: top.value.period,
      currency: top.value.currency,
      rows: top.value.rows.map((row) => ({ ...row, name: names.get(row.categoryId) ?? null })),
    });
  }

  /**
   * The top sellers with their public store names. A name that cannot be read leaves the row
   * with a null name (the panel says "Unnamed store"); the money still shows.
   */
  private async namedTopSellers(
    context: CallContext,
    input: { readonly period: PeriodRequest },
  ): Promise<Result<NamedTopSellers, KpiFailure>> {
    const top = await this.deps.reporting.marketplaceTopSellers(context, input);
    if (!top.ok) return top;
    const ids = top.value.rows.map((row) => row.sellerId as Id<'Seller'>);
    const names = new Map<string, string | null>();
    if (ids.length > 0) {
      try {
        const summaries = await this.deps.sellers.sellerSummaries(context, ids);
        if (summaries.ok) {
          for (const summary of summaries.value) names.set(summary.sellerId, summary.storeName);
        } else {
          logger.warn({
            msg: 'dashboard.admin-kpis.names',
            outcome: summaries.error.code,
          });
        }
      } catch (error) {
        logger.warn({ msg: 'dashboard.admin-kpis.names', outcome: 'threw', error: nameOf(error) });
      }
    }
    return ok({
      period: top.value.period,
      currency: top.value.currency,
      rows: top.value.rows.map((row) => ({ ...row, storeName: names.get(row.sellerId) ?? null })),
    });
  }
}
