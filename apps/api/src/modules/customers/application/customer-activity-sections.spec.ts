import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AuthorisationCheck, StepUpProofConsumer } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CustomerListRow } from '../domain/customer-list';
import { LateBoundSectionPeers } from '../infrastructure/late-bound-section-peers';
import type { CustomerSectionDependencies } from './customer-section-lists';
import type { CustomerSectionPeers } from './ports/customer-section-peers';
import type { SheetWriter } from './ports/sheet-writer';
import { InMemoryCustomerList } from './testing/in-memory-customer-list';
import { InMemoryCustomerTimeline } from './testing/in-memory-customer-management';
import { AdminCustomerAssistantConversationsSectionExport } from './use-cases/admin-customer-assistant-conversations-export.use-case';
import { AdminCustomerAssistantConversationsSection } from './use-cases/admin-customer-assistant-conversations.use-case';
import { AdminCustomerBehaviourSection } from './use-cases/admin-customer-behaviour.use-case';
import { AdminCustomerCartAdditionsSectionExport } from './use-cases/admin-customer-cart-additions-export.use-case';
import { AdminCustomerCartAdditionsSection } from './use-cases/admin-customer-cart-additions.use-case';
import { AdminCustomerCartRemindersSectionExport } from './use-cases/admin-customer-cart-reminders-export.use-case';
import { AdminCustomerCartRemindersSection } from './use-cases/admin-customer-cart-reminders.use-case';
import { AdminCustomerCartSection } from './use-cases/admin-customer-cart.use-case';
import { AdminCustomerConsentHistorySectionExport } from './use-cases/admin-customer-consent-history-export.use-case';
import { AdminCustomerConsentHistorySection } from './use-cases/admin-customer-consent-history.use-case';
import { AdminCustomerConsentSection } from './use-cases/admin-customer-consent.use-case';
import { AdminCustomerReviewsSectionExport } from './use-cases/admin-customer-reviews-export.use-case';
import { AdminCustomerReviewsSection } from './use-cases/admin-customer-reviews.use-case';
import { AdminCustomerSellerRatingsSectionExport } from './use-cases/admin-customer-seller-ratings-export.use-case';
import { AdminCustomerSellerRatingsSection } from './use-cases/admin-customer-seller-ratings.use-case';
import { AdminCustomerHelpfulVotesSectionExport } from './use-cases/admin-customer-helpful-votes-export.use-case';
import { AdminCustomerHelpfulVotesSection } from './use-cases/admin-customer-helpful-votes.use-case';
import { AdminCustomerReviewReportsSectionExport } from './use-cases/admin-customer-review-reports-export.use-case';
import { AdminCustomerReviewReportsSection } from './use-cases/admin-customer-review-reports.use-case';
import { AdminCustomerSavedItemsSectionExport } from './use-cases/admin-customer-saved-items-export.use-case';
import { AdminCustomerSavedItemsSection } from './use-cases/admin-customer-saved-items.use-case';

// The customer page's shopping, privacy and reviews sections (phase 2b, parts 2 and 3), with the
// owners faked at
// their facade, for both Market fixtures: each super list pages through its owner with the right
// request and exports behind the step-up with an audit row naming the section; each read asks
// its owner once; the owner's key and customers.customers.view are both needed; an unknown
// customer and an acting-as session never reach the owner; an unbound owner fails closed.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const NOW = Temporal.Instant.from('2026-11-16T12:00:00Z');
const VIEW = 'customers.customers.view';
const EXPORT = 'customers.customers.export';
const CART = 'cart.customer-cart.view';
const REMINDERS = 'notifications.customer-cart-reminder.view';
const BEHAVIOUR = 'engagement.customer-behaviour.view';
const CONSENT = 'legal.customer-consent.view';
const CONVERSATIONS = 'assistant.customer-conversation.view';
const REVIEWS = 'reviews.customer-review.view';
const ALL = [VIEW, EXPORT, CART, REMINDERS, BEHAVIOUR, CONSENT, CONVERSATIONS, REVIEWS];
const ID = '01990000-0000-7000-8000-000000000a01';

describe.each(['AU', 'ZZ'] as const)('customer page activity sections in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(NOW);
  const ids = new SequenceIdGenerator(clock);

  const row = (): CustomerListRow => ({
    accountId: ids.next<'Account'>(),
    email: 'buyer@example.test',
    groups: [],
    displayName: null,
    status: 'active',
    emailVerified: true,
    signedUpAt: NOW.subtract({ hours: 24 * 30 }),
    firstOrderAt: null,
    lastOrderAt: null,
    orderCount: 0,
    spentMinor: 0n,
    currency: null,
    refundCount: 0,
    refundedMinor: 0n,
  });

  function setup(peers: Partial<Record<keyof CustomerSectionPeers, object>> = {}) {
    const held = new Map<string, readonly string[]>();
    const check: AuthorisationCheck = {
      check: (context, declaration) => {
        const actor = context.actor;
        const keys = actor.kind === 'authenticated' ? (held.get(actor.accountId) ?? []) : [];
        const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
        return Promise.resolve(
          needs.every((key) => keys.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    const gate = createUseCaseGate(markets, check);
    const audits: AuditEntry[] = [];
    const audit: AuditWriter = {
      record: (_context, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const listReader = new InMemoryCustomerList();
    const timeline = new InMemoryCustomerTimeline(listReader);
    const stepUp = { refuse: null as null | 'second-factor.required', spent: [] as string[] };
    const consumer: StepUpProofConsumer = {
      consume: (_context: CallContext, actionKey: string) => {
        if (stepUp.refuse !== null) return Promise.resolve(err({ code: stepUp.refuse, actionKey }));
        stepUp.spent.push(actionKey);
        return Promise.resolve(ok({ sessionId: ids.next<'Session'>(), verifiedAt: NOW }));
      },
    };
    const sheetWriter: SheetWriter = {
      xlsx: async function* (_name, rows) {
        for await (const r of rows) yield new TextEncoder().encode(r.join('\t') + '\n');
      },
    };
    const deps: CustomerSectionDependencies = {
      unitOfWork,
      listReader,
      timeline,
      audit,
      stepUp: consumer,
      sheetWriter,
      clock,
      ids,
      peers: peers as unknown as CustomerSectionPeers,
    };
    const admin = (keys: readonly string[] = ALL): CallContext => {
      const accountId = ids.next<'Account'>();
      held.set(accountId, keys);
      return testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
    };
    const customer = row();
    listReader.add(market, customer);
    return { deps, gate, audits, timeline, stepUp, admin, customer, listReader };
  }

  const actingAs = (context: CallContext): CallContext => ({
    ...context,
    actor: { ...context.actor, actingAs: { sellerId: 'x' } } as never,
  });

  /** A page of `total` rows from the owner, cut to the window; the requests are kept. */
  function pager(total: number, row: (n: number) => object, extra: object = {}) {
    const requests: Record<string, unknown>[] = [];
    const call = (_context: CallContext, request: Record<string, unknown>) => {
      requests.push(request);
      const { offset, limit } = request['window'] as { offset: number; limit: number };
      const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, n) =>
        row(offset + n + 1),
      );
      return Promise.resolve(
        ok({ rows, total: request['withTotal'] === false ? null : total, ...extra }),
      );
    };
    return { requests, call };
  }

  const at = (n: number) => NOW.subtract({ hours: n }).toString();

  const LISTS = [
    {
      section: 'saved-items',
      key: CART,
      owner: 'cart',
      method: 'adminCustomerSavedItems',
      list: AdminCustomerSavedItemsSection,
      exporter: AdminCustomerSavedItemsSectionExport,
      row: (n: number) => ({ savedItemId: ID, offerId: ID, variantId: ID, savedAt: at(n) }),
      filters: {},
      expected: {},
    },
    {
      section: 'cart-reminders',
      key: REMINDERS,
      owner: 'reminders',
      method: 'adminCustomerCartReminders',
      list: AdminCustomerCartRemindersSection,
      exporter: AdminCustomerCartRemindersSectionExport,
      row: (n: number) => ({ cartChangedAt: at(n + 1), stage: 1, sentAt: at(n) }),
      filters: {},
      expected: {},
    },
    {
      section: 'cart-additions',
      key: BEHAVIOUR,
      owner: 'behaviour',
      method: 'adminCustomerCartAdditions',
      list: AdminCustomerCartAdditionsSection,
      exporter: AdminCustomerCartAdditionsSectionExport,
      row: (n: number) => ({ offerId: ID, variantId: ID, addedAt: at(n) }),
      filters: { from: at(48) },
      expected: { from: NOW.subtract({ hours: 48 }), to: null },
    },
    {
      section: 'consent-history',
      key: CONSENT,
      owner: 'consent',
      method: 'adminCustomerConsentHistory',
      list: AdminCustomerConsentHistorySection,
      exporter: AdminCustomerConsentHistorySectionExport,
      row: (n: number) => ({
        channel: 'email',
        granted: true,
        source: 'account',
        occurredAt: at(n),
      }),
      filters: { channel: ['email'] },
      expected: { channels: ['email'] },
    },
    {
      section: 'reviews',
      key: REVIEWS,
      owner: 'reviews',
      method: 'adminCustomerReviews',
      list: AdminCustomerReviewsSection,
      exporter: AdminCustomerReviewsSectionExport,
      row: (n: number) => ({
        reviewId: ID,
        productId: ID,
        offerId: ID,
        sellerId: ID,
        rating: 4,
        anonymous: false,
        status: 'hidden',
        createdAt: at(n),
        editedAt: null,
        publishedAt: null,
        helpfulCount: 2,
        openReports: 1,
        lastModeration: { action: 'hide', reasonCode: 'abusive', byModerator: true, at: at(n) },
      }),
      filters: { status: ['hidden', 'held'] },
      expected: { statuses: ['hidden', 'held'] },
    },
    {
      section: 'seller-ratings',
      key: REVIEWS,
      owner: 'reviews',
      method: 'adminCustomerSellerRatings',
      list: AdminCustomerSellerRatingsSection,
      exporter: AdminCustomerSellerRatingsSectionExport,
      row: (n: number) => ({
        ratingId: ID,
        sellerId: ID,
        sellerOrderId: ID,
        satisfaction: 3,
        asDescribed: true,
        arrivedOk: false,
        reasonCode: 'damaged',
        status: 'published',
        createdAt: at(n),
      }),
      filters: { status: ['published'] },
      expected: { statuses: ['published'] },
    },
    {
      section: 'helpful-votes',
      key: REVIEWS,
      owner: 'reviews',
      method: 'adminCustomerHelpfulVotes',
      list: AdminCustomerHelpfulVotesSection,
      exporter: AdminCustomerHelpfulVotesSectionExport,
      row: (n: number) => ({ reviewId: ID, productId: ID, votedAt: at(n) }),
      filters: {},
      expected: {},
    },
    {
      section: 'review-reports',
      key: REVIEWS,
      owner: 'reviews',
      method: 'adminCustomerReviewReports',
      list: AdminCustomerReviewReportsSection,
      exporter: AdminCustomerReviewReportsSectionExport,
      row: (n: number) => ({
        reportId: ID,
        reviewId: ID,
        role: 'about',
        reasonCode: 'off-topic',
        status: 'open',
        createdAt: at(n),
      }),
      filters: { role: ['about'] },
      expected: { roles: ['about'] },
    },
  ] as const;

  describe.each(LISTS)('the $section super list', (spec) => {
    const peerOf = (call: unknown) => ({ [spec.owner]: { [spec.method]: call } });

    it('pages through its owner with the filters and both paging modes', async () => {
      const owner = pager(30, spec.row);
      const { deps, gate, admin, customer } = setup(peerOf(owner.call));
      const useCase = new spec.list(gate, deps);
      const pages = await useCase.execute(admin(), {
        accountId: customer.accountId,
        filters: spec.filters,
        pageSize: 10,
      });
      expect(pages).toMatchObject({
        ok: true,
        value: { total: 30, page: 1, pageSize: 10, hasNext: true },
      });
      expect(owner.requests[0]).toMatchObject({
        accountId: customer.accountId,
        direction: 'desc',
        window: { offset: 0, limit: 10 },
        withTotal: true,
        ...spec.expected,
      });
      const prevNext = await useCase.execute(admin(), {
        accountId: customer.accountId,
        paging: 'prev-next',
        direction: 'asc',
        pageSize: 10,
      });
      expect(prevNext).toMatchObject({ ok: true, value: { total: null, hasNext: true } });
      expect(owner.requests[1]).toMatchObject({
        direction: 'asc',
        window: { limit: 11 },
        withTotal: false,
      });
    });

    it('needs both keys, a customer of the directory and no acting-as before asking', async () => {
      const owner = pager(30, spec.row);
      const { deps, gate, admin, customer } = setup(peerOf(owner.call));
      const useCase = new spec.list(gate, deps);
      for (const context of [admin([VIEW]), admin([spec.key]), actingAs(admin())]) {
        await expect(
          useCase.execute(context, { accountId: customer.accountId }),
        ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      }
      await expect(
        useCase.execute(admin(), { accountId: ids.next<'Account'>() }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'customers.customer-not-found' } });
      await expect(
        useCase.execute(admin(), { accountId: customer.accountId, filters: { nope: 1 } }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(owner.requests).toEqual([]);
    });

    it('keeps the owner’s denial and fails closed while the owner is not bound', async () => {
      const denying = () => Promise.resolve(err({ code: 'access.denied' }));
      const { deps, gate, admin, customer } = setup(peerOf(denying));
      await expect(
        new spec.list(gate, deps).execute(admin(), { accountId: customer.accountId }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      await expect(
        new spec.list(gate, { ...deps, peers: new LateBoundSectionPeers() }).execute(admin(), {
          accountId: customer.accountId,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.unavailable' } });
    });

    it('exports after spending the step-up, with an audit row naming the section', async () => {
      const owner = pager(12, spec.row);
      const { deps, gate, admin, customer, audits, stepUp } = setup(peerOf(owner.call));
      const exported = await new spec.exporter(gate, deps).execute(admin(), {
        accountId: customer.accountId,
        format: 'xlsx',
        filters: spec.filters,
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      expect(exported.value.filename).toMatch(/^customer-[a-z-]+-2026-11-16\.xlsx$/);
      let lines = 0;
      for await (const chunk of exported.value.chunks) {
        lines += new TextDecoder()
          .decode(chunk as Uint8Array)
          .split('\n')
          .filter(Boolean).length;
      }
      expect(lines).toBe(13);
      expect(owner.requests[0]).toMatchObject({
        window: { offset: 0, limit: 10_001 },
        withTotal: false,
      });
      expect(stepUp.spent).toEqual([EXPORT]);
      expect(audits).toMatchObject([
        {
          action: 'customers.customer-section.exported',
          targetId: customer.accountId,
          after: { section: spec.section, format: 'xlsx', rowCount: 12 },
        },
      ]);
    });

    it('releases nothing when the step-up is refused or the export key is missing', async () => {
      const owner = pager(3, spec.row);
      const { deps, gate, admin, customer, audits, stepUp } = setup(peerOf(owner.call));
      stepUp.refuse = 'second-factor.required';
      await expect(
        new spec.exporter(gate, deps).execute(admin(), { accountId: customer.accountId }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'second-factor.required' } });
      await expect(
        new spec.exporter(gate, deps).execute(admin([VIEW, spec.key]), {
          accountId: customer.accountId,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(audits).toEqual([]);
    });
  });

  describe('the reviews sections', () => {
    it('refuses a status or a role reviews does not keep before asking reviews', async () => {
      const owner = pager(1, () => ({}));
      const reviews = {
        adminCustomerReviews: owner.call,
        adminCustomerSellerRatings: owner.call,
        adminCustomerReviewReports: owner.call,
      };
      const { deps, gate, admin, customer } = setup({ reviews });
      const accountId = customer.accountId;
      for (const [useCase, filters] of [
        [AdminCustomerReviewsSection, { status: ['visible'] }],
        [AdminCustomerSellerRatingsSection, { status: ['held'] }],
        [AdminCustomerReviewReportsSection, { role: ['reporter'] }],
        [AdminCustomerHelpfulVotesSection, { status: ['published'] }],
      ] as const) {
        await expect(
          new useCase(gate, deps).execute(admin(), { accountId, filters }),
        ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      }
      expect(owner.requests).toEqual([]);
    });

    it('writes no review text into the export', async () => {
      const owner = pager(1, (n) => ({
        reviewId: ID,
        productId: ID,
        offerId: ID,
        sellerId: ID,
        rating: 5,
        anonymous: true,
        status: 'published',
        createdAt: at(n),
        editedAt: null,
        publishedAt: at(n),
        helpfulCount: 0,
        openReports: 0,
        lastModeration: null,
      }));
      const { deps, gate, admin, customer } = setup({
        reviews: { adminCustomerReviews: owner.call },
      });
      const exported = await new AdminCustomerReviewsSectionExport(gate, deps).execute(admin(), {
        accountId: customer.accountId,
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      let text = '';
      for await (const chunk of exported.value.chunks) text += String(chunk);
      expect(text.split('\r\n')[0]).toBe(
        '\uFEFFReview,Product,Offer,Seller,Rating,Anonymous,Status,Created at,Edited at,' +
          'Published at,Helpful votes,Open reports,Last moderation,Last moderation reason,' +
          'Last moderation by moderator,Last moderation at',
      );
      expect(text).toContain(`${ID},${ID},${ID},${ID},5,yes,published`);
    });
  });

  describe('the assistant conversations', () => {
    it('answers the count beside every page, dates only', async () => {
      const requests: Record<string, unknown>[] = [];
      const conversations = {
        adminCustomerConversations: (_context: CallContext, request: Record<string, unknown>) => {
          requests.push(request);
          return Promise.resolve(
            ok({ rows: [{ startedAt: at(2), lastMessageAt: at(1) }], total: 7 }),
          );
        },
      };
      const { deps, gate, admin, customer, audits } = setup({ conversations });
      await expect(
        new AdminCustomerAssistantConversationsSection(gate, deps).execute(admin(), {
          accountId: customer.accountId,
          paging: 'prev-next',
        }),
      ).resolves.toMatchObject({ ok: true, value: { total: null, conversationCount: 7 } });
      expect(requests[0]).toEqual({
        accountId: customer.accountId,
        direction: 'desc',
        window: { offset: 0, limit: 26 },
      });
      const exported = await new AdminCustomerAssistantConversationsSectionExport(
        gate,
        deps,
      ).execute(admin(), { accountId: customer.accountId });
      expect(exported.ok).toBe(true);
      expect(audits).toMatchObject([
        { after: { section: 'assistant-conversations', rowCount: 1 } },
      ]);
      await expect(
        new AdminCustomerAssistantConversationsSection(gate, deps).execute(admin([VIEW, CART]), {
          accountId: customer.accountId,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('the reads that are not lists', () => {
    it('reads the cart (money as a string), the behaviour and the consent from their owners', async () => {
      const cart = {
        adminCustomerCart: () =>
          Promise.resolve(
            ok({
              savedCount: 2,
              cart: {
                createdAt: at(5),
                lastChangedAt: at(1),
                lines: [
                  {
                    offerId: ID,
                    variantId: ID,
                    quantity: 3,
                    priceAtAdd: { amount: 1250n, currency: code === 'AU' ? 'AUD' : 'ZZD' },
                    addedAt: at(1),
                  },
                ],
              },
            }),
          ),
      };
      const summary = {
        personalization: { enabled: true, changedAt: null },
        summary: { productViews: 4, categoryViews: 2, cartAdditions: 1, topCategories: [] },
      };
      const behaviour = { adminCustomerBehaviour: () => Promise.resolve(ok(summary)) };
      const channels = [{ channel: 'email', granted: false, source: null, changedAt: null }];
      const consent = { adminCustomerConsent: () => Promise.resolve(ok({ channels })) };
      const { deps, gate, admin, customer } = setup({ cart, behaviour, consent });
      const accountId = customer.accountId;
      const read = await new AdminCustomerCartSection(gate, deps).execute(admin(), { accountId });
      expect(read).toMatchObject({
        ok: true,
        value: {
          savedCount: 2,
          cart: { lines: [{ quantity: 3, priceAtAdd: { amount: '1250' } }] },
        },
      });
      expect(JSON.stringify(read)).toContain('"amount":"1250"');
      await expect(
        new AdminCustomerBehaviourSection(gate, deps).execute(admin(), { accountId }),
      ).resolves.toEqual({ ok: true, value: summary });
      await expect(
        new AdminCustomerConsentSection(gate, deps).execute(admin(), { accountId }),
      ).resolves.toEqual({ ok: true, value: { channels } });
    });

    it('needs the owner’s key, a closed body and a customer of the directory', async () => {
      let asked = 0;
      const cart = {
        adminCustomerCart: () => {
          asked += 1;
          return Promise.resolve(ok({ savedCount: 0, cart: null }));
        },
      };
      const { deps, gate, admin, customer } = setup({ cart });
      const useCase = new AdminCustomerCartSection(gate, deps);
      await expect(
        useCase.execute(admin([VIEW, BEHAVIOUR]), { accountId: customer.accountId }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      await expect(
        useCase.execute(admin(), { accountId: customer.accountId, extra: 1 }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      await expect(
        useCase.execute(admin(), { accountId: ids.next<'Account'>() }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'customers.customer-not-found' } });
      await expect(
        useCase.execute(actingAs(admin()), { accountId: customer.accountId }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(asked).toBe(0);
    });
  });
});
