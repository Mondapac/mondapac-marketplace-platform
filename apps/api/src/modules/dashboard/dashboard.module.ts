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
import {
  CERTIFICATION_PRODUCT_CERTIFICATE_VIEW,
  CERTIFICATION_SELLER_CERTIFICATE_VIEW,
  CERTIFICATION_WORK_QUEUE_FACADE,
  CertificationModule,
  type CertificationWorkQueueFacade,
} from '../certification';
import {
  COMMISSION_PAYOUTS_DISPUTE_VIEW,
  COMMISSION_PAYOUTS_EARNINGS_VIEW,
  COMMISSION_PAYOUTS_PAYOUT_VIEW,
  COMMISSION_PAYOUTS_SETTLEMENT_VIEW,
  COMMISSION_PAYOUTS_WORK_QUEUE_FACADE,
  CommissionPayoutsModule,
  type CommissionPayoutsWorkQueueFacade,
} from '../commission-payouts';
import { IDENTITY_FACADE, IdentityModule, type IdentityFacade } from '../identity';
import {
  ORDERING_ORDER_VIEW,
  ORDERING_SELLER_ORDER_VIEW,
  ORDERING_WORK_QUEUE_FACADE,
  OrderingModule,
  type OrderingWorkQueueFacade,
} from '../ordering';
import {
  PAYMENTS_CONNECTED_ACCOUNT_VIEW,
  PAYMENTS_CUSTOMER_PAYMENT_VIEW,
  PAYMENTS_PAYOUT_ACCOUNT_VIEW,
  PAYMENTS_WORK_QUEUE_FACADE,
  PaymentsModule,
  type PaymentsWorkQueueFacade,
} from '../payments';
import {
  PRICING_PRICE_HOLD_VIEW,
  PRICING_WORK_QUEUE_FACADE,
  PricingModule,
  type PricingWorkQueueFacade,
} from '../pricing';
import {
  REVIEWS_SELLER_VIEW,
  REVIEWS_WORK_QUEUE_FACADE,
  ReviewsModule,
  type ReviewsWorkQueueFacade,
} from '../reviews';
import {
  SECURITY_VIEW,
  SECURITY_WORK_QUEUE_FACADE,
  SecurityModule,
  type SecurityWorkQueueFacade,
} from '../security';
import {
  SELLERS_SELLER_VIEW,
  SELLERS_WORK_QUEUE_FACADE,
  SellersModule,
  type SellersWorkQueueFacade,
} from '../sellers';
import { VIEWER_PERMISSIONS, type ViewerPermissions } from './application/ports/viewer-permissions';
import {
  ViewAdminWorkQueue,
  type DashboardDependencies,
} from './application/use-cases/view-admin-work-queue.use-case';
import { ViewSellerTasks } from './application/use-cases/view-seller-tasks.use-case';
import { WorkQueueCache } from './application/work-queue-cache';
import { WORK_QUEUE_TIMEOUT_MS } from './application/work-queue-flow';
import {
  checkWorkQueueSources,
  WORK_QUEUE_SOURCES,
  type WorkQueueSource,
} from './application/work-queue-source';
import { IdentityViewerPermissions } from './infrastructure/identity-viewer-permissions';
import { AdminDashboardController } from './presentation/admin-dashboard.controller';
import { SellerDashboardController } from './presentation/seller-dashboard.controller';

/** The age limit of a failed payment, webhook or payout (design section 2: every item over 1 hour). */
const FAILED_ITEM_STALE_AFTER_MINUTES = 60;

/** The owners' facades the work-queue sources are bound to. */
export interface WorkQueueOwners {
  readonly ordering: OrderingWorkQueueFacade;
  readonly catalog: CatalogWorkQueueFacade;
  readonly pricing: PricingWorkQueueFacade;
  readonly sellers: SellersWorkQueueFacade;
  readonly security: SecurityWorkQueueFacade;
  readonly certification: CertificationWorkQueueFacade;
  readonly payments: PaymentsWorkQueueFacade;
  readonly commissionPayouts: CommissionPayoutsWorkQueueFacade;
  readonly reviews: ReviewsWorkQueueFacade;
}

/**
 * The work-queue sources of both panels, each bound to its owner's public facade (design
 * section 2), in the order the panel shows them within a level. Phase 1 adds them module by
 * module (ordering, catalog and sellers, security and certification, payments and
 * commission-payouts), then the seller tasks (PR 6; docs/modules/dashboard/notes.md).
 */
export function workQueueSources(owners: WorkQueueOwners): readonly WorkQueueSource[] {
  const { ordering, catalog, pricing, sellers, security, certification, payments } = owners;
  const { commissionPayouts, reviews } = owners;
  return [
    {
      key: 'catalog.claims-without-certificate',
      panel: 'admin',
      level: 'critical',
      requires: [CATALOG_PRODUCT_VIEW.key],
      live: true,
      count: (context, query) => catalog.claimsWithoutCertificate(context, query),
    },
    {
      key: 'security.open-alerts',
      panel: 'admin',
      level: 'critical',
      requires: [SECURITY_VIEW.key],
      live: true,
      count: (context, query) => security.openAlerts(context, query),
    },
    {
      key: 'commission-payouts.disputes-due',
      panel: 'admin',
      level: 'critical',
      requires: [COMMISSION_PAYOUTS_DISPUTE_VIEW.key],
      live: true,
      count: (context, query) => commissionPayouts.disputesDue(context, query),
    },
    {
      key: 'ordering.late-deliveries',
      panel: 'admin',
      level: 'critical',
      requires: [ORDERING_ORDER_VIEW.key],
      live: false,
      count: (context, query) => ordering.lateDeliveries(context, query),
    },
    {
      key: 'ordering.failed-payments',
      panel: 'admin',
      level: 'today',
      requires: [ORDERING_ORDER_VIEW.key],
      live: false,
      staleAfterMinutes: FAILED_ITEM_STALE_AFTER_MINUTES,
      count: (context, query) => ordering.failedPayments(context, query),
    },
    {
      key: 'payments.failed-webhooks',
      panel: 'admin',
      level: 'today',
      requires: [PAYMENTS_CUSTOMER_PAYMENT_VIEW.key],
      live: false,
      staleAfterMinutes: FAILED_ITEM_STALE_AFTER_MINUTES,
      count: (context, query) => payments.failedWebhooks(context, query),
    },
    {
      key: 'commission-payouts.failed-payouts',
      panel: 'admin',
      level: 'today',
      requires: [COMMISSION_PAYOUTS_PAYOUT_VIEW.key],
      live: false,
      staleAfterMinutes: FAILED_ITEM_STALE_AFTER_MINUTES,
      count: (context, query) => commissionPayouts.failedPayouts(context, query),
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
      key: 'payments.restricted-accounts',
      panel: 'admin',
      level: 'today',
      requires: [PAYMENTS_CONNECTED_ACCOUNT_VIEW.key],
      live: false,
      count: (context, query) => payments.restrictedAccounts(context, query),
    },
    {
      key: 'commission-payouts.payout-holds',
      panel: 'admin',
      level: 'today',
      requires: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key],
      live: false,
      count: (context, query) => commissionPayouts.payoutHolds(context, query),
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
    {
      key: 'certification.seller-certificates',
      panel: 'admin',
      level: 'review',
      requires: [CERTIFICATION_SELLER_CERTIFICATE_VIEW.key],
      live: false,
      count: (context, query) => certification.sellerCertificates(context, query),
    },
    {
      key: 'certification.product-certificates',
      panel: 'admin',
      level: 'review',
      requires: [CERTIFICATION_PRODUCT_CERTIFICATE_VIEW.key],
      live: false,
      count: (context, query) => certification.productCertificates(context, query),
    },
    // The seller tasks (PR 6): always the session's own seller.
    {
      key: 'ordering.late-orders',
      panel: 'seller',
      level: 'critical',
      requires: [ORDERING_SELLER_ORDER_VIEW.key],
      live: true,
      count: (context, query) => ordering.sellerLateOrders(context, query),
    },
    {
      key: 'commission-payouts.dispute-reply-needed',
      panel: 'seller',
      level: 'critical',
      requires: [COMMISSION_PAYOUTS_EARNINGS_VIEW.key],
      live: true,
      count: (context, query) => commissionPayouts.sellerDisputesNeedingReply(context, query),
    },
    {
      key: 'payments.payouts-blocked',
      panel: 'seller',
      level: 'critical',
      requires: [PAYMENTS_PAYOUT_ACCOUNT_VIEW.key],
      live: false,
      count: (context, query) => payments.sellerPayoutsBlocked(context, query),
    },
    {
      key: 'ordering.to-ship-today',
      panel: 'seller',
      level: 'today',
      requires: [ORDERING_SELLER_ORDER_VIEW.key],
      live: false,
      count: (context, query) => ordering.sellerToShipToday(context, query),
    },
    {
      key: 'ordering.pickups-uncollected',
      panel: 'seller',
      level: 'today',
      requires: [ORDERING_SELLER_ORDER_VIEW.key],
      live: false,
      count: (context, query) => ordering.sellerPickupsUncollected(context, query),
    },
    {
      key: 'commission-payouts.payout-holds',
      panel: 'seller',
      level: 'today',
      requires: [COMMISSION_PAYOUTS_EARNINGS_VIEW.key],
      live: false,
      count: (context, query) => commissionPayouts.sellerPayoutHolds(context, query),
    },
    {
      key: 'reviews.unanswered',
      panel: 'seller',
      level: 'review',
      requires: [REVIEWS_SELLER_VIEW.key],
      live: false,
      count: (context, query) => reviews.sellerUnanswered(context, query),
    },
  ];
}

/**
 * Dashboard (dashboards upgrade, option B; design section 6): a composition module with no tables
 * of its own. It reads only through other modules' public facades, with the caller's context
 * unchanged, and no module imports it (dependency-cruiser `nothing-imports-dashboard`).
 */
@Module({
  imports: [
    IdentityModule,
    OrderingModule,
    CatalogModule,
    PricingModule,
    SellersModule,
    SecurityModule,
    CertificationModule,
    PaymentsModule,
    CommissionPayoutsModule,
    ReviewsModule,
  ],
  controllers: [AdminDashboardController, SellerDashboardController],
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
        SECURITY_WORK_QUEUE_FACADE,
        CERTIFICATION_WORK_QUEUE_FACADE,
        PAYMENTS_WORK_QUEUE_FACADE,
        COMMISSION_PAYOUTS_WORK_QUEUE_FACADE,
        REVIEWS_WORK_QUEUE_FACADE,
      ],
      useFactory: (
        ordering: OrderingWorkQueueFacade,
        catalog: CatalogWorkQueueFacade,
        pricing: PricingWorkQueueFacade,
        sellers: SellersWorkQueueFacade,
        security: SecurityWorkQueueFacade,
        certification: CertificationWorkQueueFacade,
        payments: PaymentsWorkQueueFacade,
        commissionPayouts: CommissionPayoutsWorkQueueFacade,
        reviews: ReviewsWorkQueueFacade,
      ) => {
        const sources = workQueueSources({
          ordering,
          catalog,
          pricing,
          sellers,
          security,
          certification,
          payments,
          commissionPayouts,
          reviews,
        });
        checkWorkQueueSources(sources);
        return sources;
      },
    },
    { provide: WorkQueueCache, useFactory: () => new WorkQueueCache() },
    ...[ViewAdminWorkQueue, ViewSellerTasks].map((type) => ({
      provide: type,
      inject: [USE_CASE_GATE, VIEWER_PERMISSIONS, WORK_QUEUE_SOURCES, WorkQueueCache, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        viewer: ViewerPermissions,
        sources: readonly WorkQueueSource[],
        cache: WorkQueueCache,
        clock: Clock,
      ) => {
        const deps: DashboardDependencies = {
          viewer,
          sources,
          cache,
          clock,
          timeoutMs: WORK_QUEUE_TIMEOUT_MS,
        };
        return new type(gate, deps);
      },
    })),
  ],
})
export class DashboardModule {}
