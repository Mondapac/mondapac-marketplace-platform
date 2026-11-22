import { Module } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import {
  CATALOG_BRAND_READ,
  CATALOG_CATEGORY_PROPOSAL_DECIDE,
  CATALOG_PRODUCT_VIEW,
  CATALOG_WORK_QUEUE_FACADE,
  CatalogModule,
  type CatalogWorkQueueFacade,
} from '../catalog';
import { IDENTITY_FACADE, IdentityModule, type IdentityFacade } from '../identity';
import {
  ORDERING_ORDER_VIEW,
  ORDERING_WORK_QUEUE_FACADE,
  OrderingModule,
  type OrderingWorkQueueFacade,
} from '../ordering';
import {
  PRICING_PRICE_HOLD_VIEW,
  PRICING_WORK_QUEUE_FACADE,
  PricingModule,
  type PricingWorkQueueFacade,
} from '../pricing';
import {
  SELLERS_SELLER_VIEW,
  SELLERS_WORK_QUEUE_FACADE,
  SellersModule,
  type SellersWorkQueueFacade,
} from '../sellers';
import { VIEWER_PERMISSIONS, type ViewerPermissions } from './application/ports/viewer-permissions';
import { ViewAdminWorkQueue } from './application/use-cases/view-admin-work-queue.use-case';
import { WorkQueueCache } from './application/work-queue-cache';
import { WORK_QUEUE_TIMEOUT_MS } from './application/work-queue-flow';
import {
  checkWorkQueueSources,
  WORK_QUEUE_SOURCES,
  type WorkQueueSource,
} from './application/work-queue-source';
import { IdentityViewerPermissions } from './infrastructure/identity-viewer-permissions';
import { AdminDashboardController } from './presentation/admin-dashboard.controller';

/** The owners' facades the work-queue sources are bound to. */
export interface WorkQueueOwners {
  readonly ordering: OrderingWorkQueueFacade;
  readonly catalog: CatalogWorkQueueFacade;
  readonly pricing: PricingWorkQueueFacade;
  readonly sellers: SellersWorkQueueFacade;
}

/**
 * The work-queue sources of both panels, each bound to its owner's public facade (design
 * section 2), in the order the panel shows them within a level. Phase 1 adds them module by
 * module (ordering, catalog and sellers, security and certification, payments and
 * commission-payouts).
 */
export function workQueueSources(owners: WorkQueueOwners): readonly WorkQueueSource[] {
  const { ordering, catalog, pricing, sellers } = owners;
  return [
    {
      key: 'ordering.late-deliveries',
      panel: 'admin',
      level: 'critical',
      requires: [ORDERING_ORDER_VIEW.key],
      live: false,
      count: (context, query) => ordering.lateDeliveries(context, query),
    },
    {
      key: 'ordering.pending-refunds',
      panel: 'admin',
      level: 'today',
      requires: [ORDERING_ORDER_VIEW.key],
      live: false,
      count: (context, query) => ordering.pendingRefunds(context, query),
    },
    {
      key: 'sellers.applications',
      panel: 'admin',
      level: 'today',
      requires: [SELLERS_SELLER_VIEW.key],
      live: false,
      count: (context, query) => sellers.applications(context, query),
    },
    {
      key: 'catalog.pending-offers',
      panel: 'admin',
      level: 'today',
      requires: [CATALOG_PRODUCT_VIEW.key],
      live: false,
      count: (context, query) => catalog.pendingOffers(context, query),
    },
    {
      key: 'catalog.pending-revisions',
      panel: 'admin',
      level: 'today',
      requires: [CATALOG_PRODUCT_VIEW.key],
      live: false,
      count: (context, query) => catalog.pendingRevisions(context, query),
    },
    {
      key: 'pricing.price-holds',
      panel: 'admin',
      level: 'today',
      requires: [PRICING_PRICE_HOLD_VIEW.key],
      live: false,
      count: (context, query) => pricing.priceHolds(context, query),
    },
    {
      key: 'sellers.health-queue',
      panel: 'admin',
      level: 'today',
      requires: [SELLERS_SELLER_VIEW.key],
      live: false,
      count: (context, query) => sellers.unhealthySellers(context, query),
    },
    {
      key: 'catalog.brand-merges',
      panel: 'admin',
      level: 'review',
      requires: [CATALOG_BRAND_READ.key],
      live: false,
      count: (context, query) => catalog.brandMerges(context, query),
    },
    {
      key: 'catalog.category-proposals',
      panel: 'admin',
      level: 'review',
      requires: [CATALOG_CATEGORY_PROPOSAL_DECIDE.key],
      live: false,
      count: (context, query) => catalog.categoryProposals(context, query),
    },
  ];
}

/**
 * Dashboard (dashboards upgrade, option B; design section 6): a composition module with no tables
 * of its own. It reads only through other modules' public facades, with the caller's context
 * unchanged, and no module imports it (dependency-cruiser `nothing-imports-dashboard`).
 */
@Module({
  imports: [IdentityModule, OrderingModule, CatalogModule, PricingModule, SellersModule],
  controllers: [AdminDashboardController],
  providers: [
    {
      provide: VIEWER_PERMISSIONS,
      inject: [IDENTITY_FACADE],
      useFactory: (identity: IdentityFacade) => new IdentityViewerPermissions(identity),
    },
    {
      provide: WORK_QUEUE_SOURCES,
      inject: [
        ORDERING_WORK_QUEUE_FACADE,
        CATALOG_WORK_QUEUE_FACADE,
        PRICING_WORK_QUEUE_FACADE,
        SELLERS_WORK_QUEUE_FACADE,
      ],
      useFactory: (
        ordering: OrderingWorkQueueFacade,
        catalog: CatalogWorkQueueFacade,
        pricing: PricingWorkQueueFacade,
        sellers: SellersWorkQueueFacade,
      ) => {
        const sources = workQueueSources({ ordering, catalog, pricing, sellers });
        checkWorkQueueSources(sources);
        return sources;
      },
    },
    { provide: WorkQueueCache, useFactory: () => new WorkQueueCache() },
    {
      provide: ViewAdminWorkQueue,
      inject: [USE_CASE_GATE, VIEWER_PERMISSIONS, WORK_QUEUE_SOURCES, WorkQueueCache, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        viewer: ViewerPermissions,
        sources: readonly WorkQueueSource[],
        cache: WorkQueueCache,
        clock: Clock,
      ) =>
        new ViewAdminWorkQueue(gate, {
          viewer,
          sources,
          cache,
          clock,
          timeoutMs: WORK_QUEUE_TIMEOUT_MS,
        }),
    },
  ],
})
export class DashboardModule {}
