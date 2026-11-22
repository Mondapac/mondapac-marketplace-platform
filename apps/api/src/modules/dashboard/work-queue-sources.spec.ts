import { ok, Temporal } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { PLATFORM_TENANT_ID } from '../../platform/market-context/tenant';
import {
  CATALOG_BRAND_READ,
  CATALOG_CATEGORY_PROPOSAL_DECIDE,
  CATALOG_PRODUCT_VIEW,
} from '../catalog';
import {
  CERTIFICATION_PRODUCT_CERTIFICATE_VIEW,
  CERTIFICATION_SELLER_CERTIFICATE_VIEW,
} from '../certification';
import {
  COMMISSION_PAYOUTS_DISPUTE_VIEW,
  COMMISSION_PAYOUTS_PAYOUT_VIEW,
  COMMISSION_PAYOUTS_SETTLEMENT_VIEW,
} from '../commission-payouts';
import { ORDERING_ORDER_VIEW } from '../ordering';
import { PAYMENTS_CONNECTED_ACCOUNT_VIEW, PAYMENTS_CUSTOMER_PAYMENT_VIEW } from '../payments';
import { PRICING_PRICE_HOLD_VIEW } from '../pricing';
import { SECURITY_VIEW } from '../security';
import { SELLERS_SELLER_VIEW } from '../sellers';
import { checkWorkQueueSources } from './application/work-queue-source';
import { workQueueSources, type WorkQueueOwners } from './dashboard.module';

// The bound sources of the work queue (dashboards upgrade, phase 1): each queue's key, panel, level,
// keys and cache mode as the design gives them, and each one calls its owner's facade method with
// the caller's context and query unchanged.

const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const COUNT = { count: 1, overdue: 0, oldestAt: NOW };

describe('the bound work-queue sources', () => {
  const calls: { method: string; context: unknown; query: unknown }[] = [];
  const record = (method: string) => (context: unknown, query: unknown) => {
    calls.push({ method, context, query });
    return Promise.resolve(ok(COUNT));
  };
  const owners: WorkQueueOwners = {
    ordering: {
      lateDeliveries: record('ordering.lateDeliveries'),
      pendingRefunds: record('ordering.pendingRefunds'),
      failedPayments: record('ordering.failedPayments'),
    },
    catalog: {
      claimsWithoutCertificate: record('catalog.claimsWithoutCertificate'),
      pendingOffers: record('catalog.pendingOffers'),
      pendingRevisions: record('catalog.pendingRevisions'),
      brandMerges: record('catalog.brandMerges'),
      categoryProposals: record('catalog.categoryProposals'),
    },
    pricing: { priceHolds: record('pricing.priceHolds') },
    sellers: {
      applications: record('sellers.applications'),
      unhealthySellers: record('sellers.unhealthySellers'),
    },
    security: { openAlerts: record('security.openAlerts') },
    certification: {
      sellerCertificates: record('certification.sellerCertificates'),
      productCertificates: record('certification.productCertificates'),
    },
    payments: {
      failedWebhooks: record('payments.failedWebhooks'),
      restrictedAccounts: record('payments.restrictedAccounts'),
    },
    commissionPayouts: {
      failedPayouts: record('commissionPayouts.failedPayouts'),
      payoutHolds: record('commissionPayouts.payoutHolds'),
      disputesDue: record('commissionPayouts.disputesDue'),
    },
  };
  const sources = workQueueSources(owners);

  it('passes the boot check', () => {
    expect(() => checkWorkQueueSources(sources)).not.toThrow();
  });

  it('binds each queue as the design gives it', () => {
    expect(
      sources.map(({ key, panel, level, requires, live, staleAfterMinutes }) => ({
        key,
        panel,
        level,
        requires,
        live,
        staleAfterMinutes,
      })),
    ).toEqual([
      {
        key: 'catalog.claims-without-certificate',
        panel: 'admin',
        level: 'critical',
        requires: [CATALOG_PRODUCT_VIEW.key],
        live: true,
      },
      {
        key: 'security.open-alerts',
        panel: 'admin',
        level: 'critical',
        requires: [SECURITY_VIEW.key],
        live: true,
      },
      {
        key: 'commission-payouts.disputes-due',
        panel: 'admin',
        level: 'critical',
        requires: [COMMISSION_PAYOUTS_DISPUTE_VIEW.key],
        live: true,
      },
      {
        key: 'ordering.late-deliveries',
        panel: 'admin',
        level: 'critical',
        requires: [ORDERING_ORDER_VIEW.key],
        live: false,
      },
      {
        key: 'ordering.failed-payments',
        panel: 'admin',
        level: 'today',
        requires: [ORDERING_ORDER_VIEW.key],
        live: false,
        staleAfterMinutes: 60,
      },
      {
        key: 'payments.failed-webhooks',
        panel: 'admin',
        level: 'today',
        requires: [PAYMENTS_CUSTOMER_PAYMENT_VIEW.key],
        live: false,
        staleAfterMinutes: 60,
      },
      {
        key: 'commission-payouts.failed-payouts',
        panel: 'admin',
        level: 'today',
        requires: [COMMISSION_PAYOUTS_PAYOUT_VIEW.key],
        live: false,
        staleAfterMinutes: 60,
      },
      {
        key: 'ordering.pending-refunds',
        panel: 'admin',
        level: 'today',
        requires: [ORDERING_ORDER_VIEW.key],
        live: false,
      },
      {
        key: 'sellers.applications',
        panel: 'admin',
        level: 'today',
        requires: [SELLERS_SELLER_VIEW.key],
        live: false,
      },
      {
        key: 'catalog.pending-offers',
        panel: 'admin',
        level: 'today',
        requires: [CATALOG_PRODUCT_VIEW.key],
        live: false,
      },
      {
        key: 'catalog.pending-revisions',
        panel: 'admin',
        level: 'today',
        requires: [CATALOG_PRODUCT_VIEW.key],
        live: false,
      },
      {
        key: 'pricing.price-holds',
        panel: 'admin',
        level: 'today',
        requires: [PRICING_PRICE_HOLD_VIEW.key],
        live: false,
      },
      {
        key: 'payments.restricted-accounts',
        panel: 'admin',
        level: 'today',
        requires: [PAYMENTS_CONNECTED_ACCOUNT_VIEW.key],
        live: false,
      },
      {
        key: 'commission-payouts.payout-holds',
        panel: 'admin',
        level: 'today',
        requires: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key],
        live: false,
      },
      {
        key: 'sellers.health-queue',
        panel: 'admin',
        level: 'today',
        requires: [SELLERS_SELLER_VIEW.key],
        live: false,
      },
      {
        key: 'catalog.brand-merges',
        panel: 'admin',
        level: 'review',
        requires: [CATALOG_BRAND_READ.key],
        live: false,
      },
      {
        key: 'catalog.category-proposals',
        panel: 'admin',
        level: 'review',
        requires: [CATALOG_CATEGORY_PROPOSAL_DECIDE.key],
        live: false,
      },
      {
        key: 'certification.seller-certificates',
        panel: 'admin',
        level: 'review',
        requires: [CERTIFICATION_SELLER_CERTIFICATE_VIEW.key],
        live: false,
      },
      {
        key: 'certification.product-certificates',
        panel: 'admin',
        level: 'review',
        requires: [CERTIFICATION_PRODUCT_CERTIFICATE_VIEW.key],
        live: false,
      },
    ]);
  });

  it("calls each owner's facade with the caller's context and query unchanged", async () => {
    const market = testMarketContext('AU', PLATFORM_TENANT_ID);
    const context = testCallContext(market, 'system');
    const query = { now: NOW, staleBefore: NOW, signal: new AbortController().signal };
    for (const source of sources) expect(await source.count(context, query)).toEqual(ok(COUNT));
    expect(calls.map((c) => c.method)).toEqual([
      'catalog.claimsWithoutCertificate',
      'security.openAlerts',
      'commissionPayouts.disputesDue',
      'ordering.lateDeliveries',
      'ordering.failedPayments',
      'payments.failedWebhooks',
      'commissionPayouts.failedPayouts',
      'ordering.pendingRefunds',
      'sellers.applications',
      'catalog.pendingOffers',
      'catalog.pendingRevisions',
      'pricing.priceHolds',
      'payments.restrictedAccounts',
      'commissionPayouts.payoutHolds',
      'sellers.unhealthySellers',
      'catalog.brandMerges',
      'catalog.categoryProposals',
      'certification.sellerCertificates',
      'certification.productCertificates',
    ]);
    expect(calls.every((c) => c.context === context && c.query === query)).toBe(true);
  });
});
