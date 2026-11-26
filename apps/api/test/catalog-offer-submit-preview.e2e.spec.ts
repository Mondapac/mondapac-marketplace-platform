import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, PendingEvent } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CheckClaimText } from '../src/modules/catalog/application/claim-text/check-claim-text.service';
import { ALLOWED_PRODUCT_TYPES_READER } from '../src/modules/catalog/application/ports/allowed-product-types.reader';
import { CLAIM_EVALUATOR } from '../src/modules/catalog/application/ports/claim-evaluator';
import {
  OFFER_REVIEW_INPUTS,
  OFFER_REVIEW_REFERRAL_STORE,
  SAFE_OFFER_REVIEW_SETTINGS,
  type OfferReviewFactsRead,
  type OfferReviewReferral,
  type OfferReviewSettings,
} from '../src/modules/catalog/application/ports/offer-review';
import {
  OFFER_POST_REVIEW_REPOSITORY,
  OFFER_POST_REVIEW_SAMPLER,
} from '../src/modules/catalog/application/ports/offer-post-review';
import { FIRST_PRICE_REFERENCE } from '../src/modules/pricing/application/reference/variant-reference';
import { OFFER_REPOSITORY } from '../src/modules/catalog/application/ports/offer.repository';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import {
  RATE_COUNTER_REPOSITORY,
  type RateCounter,
} from '../src/modules/catalog/application/ports/rate-counter.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { ClaimQueryBuilder } from '../src/modules/catalog/application/tags/claim-query-builder';
import { Offer, type OfferState } from '../src/modules/catalog/domain/offer';
import { sellerReviewReasonsOf } from '../src/modules/catalog/domain/offer-review-policy';
import { Product, type ProductState } from '../src/modules/catalog/domain/product';
import type { RateReservation } from '../src/modules/catalog/domain/rate-limits';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { AUDIT_WRITER } from '../src/platform/audit/audit-writer';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { REVIEW_OFF } from './support/catalog-offer-edit-review-fakes';
import { InMemoryOfferPostReviews } from './support/catalog-offer-post-review-fakes';
import { FakeClaimEvaluator, FixedFactsClaimQueryBuilder } from './support/catalog-tag-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller's submit preview over HTTP (risk-based Offer approval slice 7b, design 9.5 a): the
// real guards, controller, gate, preview and submit use cases, with identity's ports and catalog's
// stores as in-memory fakes. Proved here, in both Markets: the same answer as the real submit, a
// sampled and an unsampled Offer answer byte for byte the same, every reason a seller may not see
// is one byte-identical `held-for-review`, the matched contact text is never echoed, a failed read
// is 503 and never a guess, the per-seller budget, and that the preview writes nothing.

const START = Temporal.Instant.from('2026-11-26T03:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const OWNER_2 = id<'Account'>(0xa102);
const OTHER_OWNER = id<'Account'>(0xa103);
const SELLER = id<'Seller'>(0xb020);
const OTHER_SELLER = id<'Seller'>(0xb021);
const PRODUCT = id<'Product'>(0xc001);
const OFFER = id<'Offer'>(0x9001);

/** A Trusted seller with no flag, read without a failure. */
const CLEAN_FACTS: OfferReviewFactsRead = Object.freeze({
  emergencyStop: false,
  probation: false,
  fullReview: false,
  sensitiveCategory: false,
  degraded: false,
  stampTrust: false,
  probationOffers: 10,
  trustedSince: null,
});
const RISK_BASED: OfferReviewSettings = Object.freeze({
  mode: 'risk-based',
  certificateBadges: 'review',
  emergencyStop: false,
  samplingPercent: 5,
});

/** The fixed windows of `catalog.rate_counters`, in memory. */
class MemoryRateCounters {
  readonly counts = new Map<string, { count: number; startedAt: Temporal.Instant }>();
  reserved: RateCounter[][] = [];
  reserve(
    _m: MarketContext,
    counters: readonly RateCounter[],
    now: Temporal.Instant,
  ): Promise<readonly RateReservation[]> {
    this.reserved.push([...counters]);
    return Promise.resolve(
      counters.map(({ limit, keyHash }) => {
        const key = `${limit.kind}:${Buffer.from(keyHash).toString('hex')}`;
        const held = this.counts.get(key);
        const ended =
          held === undefined ||
          Temporal.Instant.compare(held.startedAt.add({ minutes: limit.windowMinutes }), now) <= 0;
        const next = ended ? { count: 1, startedAt: now } : { ...held, count: held.count + 1 };
        this.counts.set(key, next);
        return { kind: limit.kind, count: next.count, windowStartedAt: next.startedAt };
      }),
    );
  }
  purgeStartedBefore(): Promise<number> {
    return Promise.resolve(0);
  }
}

/** An object whose named methods record the call and throw. */
const tripwire = (name: string, methods: readonly string[]) =>
  Object.fromEntries(
    methods.map((method) => [
      method,
      () => {
        forbiddenCalls.push(`${name}.${method}`);
        throw new Error(`${name}.${method} must not be called by the preview`);
      },
    ]),
  );
let forbiddenCalls: string[] = [];

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('seller submit preview over HTTP (integration, slice 7b)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let clock: FixedClock;
  let offer: Offer | null;
  let saved: Offer[];
  let events: PendingEvent[];
  let audits: { action: string }[];
  let referrals: OfferReviewReferral[];
  let postReviews: InMemoryOfferPostReviews;
  let counters: MemoryRateCounters;
  let reviewSettings: OfferReviewSettings;
  let reviewFacts: OfferReviewFactsRead;
  let factReads: number;
  let eligible: boolean;
  let allowed: 'all' | Set<string> | null;
  /** Every call that reached the sampler or pricing's R4 ports: the preview must make none. */
  let forbidden: string[];
  let claimChecks: number;
  let evaluator: FakeClaimEvaluator;
  let productState: (code: string) => ProductState;
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(OUTBOX_WRITER)
          .useValue({
            append: (_c: unknown, pending: readonly PendingEvent[]) => {
              events.push(...pending);
              return Promise.resolve();
            },
          })
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({
            findById: () => Promise.resolve(offer === null ? null : Offer.restore(offer.state)),
            save: (_m: unknown, edited: Offer) => {
              saved.push(edited);
              return Promise.resolve(null);
            },
          })
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({
            findById: (m: MarketContext) =>
              Promise.resolve(Product.restore(productState(m.marketId))),
          })
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(eligible) })
          .overrideProvider(ALLOWED_PRODUCT_TYPES_READER)
          .useValue({ allowedFor: () => Promise.resolve(allowed) })
          .overrideProvider(CheckClaimText)
          .useValue({
            execute: () => {
              claimChecks += 1;
              return Promise.resolve({ ok: true, value: [] });
            },
          })
          .overrideProvider(CLAIM_EVALUATOR)
          .useValue(evaluator)
          .overrideProvider(ClaimQueryBuilder)
          .useValue(new FixedFactsClaimQueryBuilder(null))
          .overrideProvider(OFFER_REVIEW_REFERRAL_STORE)
          .useValue({
            record: (_m: unknown, referral: OfferReviewReferral) => {
              referrals.push(referral);
              return Promise.resolve();
            },
          })
          .overrideProvider(OFFER_REVIEW_INPUTS)
          .useValue({
            settings: () => Promise.resolve(reviewSettings),
            probationOffers: () => Promise.resolve(10),
            facts: () => {
              factReads += 1;
              return Promise.resolve(reviewFacts);
            },
          })
          .overrideProvider(OFFER_POST_REVIEW_REPOSITORY)
          .useValue(postReviews)
          .overrideProvider(RATE_COUNTER_REPOSITORY)
          .useValue(counters)
          // The sampler and pricing's R4 reference: any call is recorded and fails.
          .overrideProvider(OFFER_POST_REVIEW_SAMPLER)
          .useValue(tripwire('sampler', ['bucketOf']))
          .overrideProvider(FIRST_PRICE_REFERENCE)
          .useValue({
            prices: tripwire('r4.prices', ['regularPricesInForce']),
            businesses: tripwire('r4.businesses', ['eligibleSellers']),
            settings: tripwire('r4.settings', ['settings']),
            checks: tripwire('r4.checks', ['record', 'pendingRechecks', 'markRechecked']),
          })
          .overrideProvider(AUDIT_WRITER)
          .useValue({
            record: (_c: unknown, entry: { action: string }) => {
              audits.push(entry);
              return Promise.resolve();
            },
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const baseProduct = (code: string): ProductState => ({
    id: PRODUCT,
    marketId: code as AccountState['marketId'],
    scope: 'PLATFORM',
    ownerSellerId: null,
    createdBySellerId: null,
    typeCode: 'simple',
    variantModel: 'single',
    familyCode: 'default',
    productCode: 'P00000001',
    status: 'published',
    discardedAt: null,
    withdrawnAt: null,
    retiredAt: null,
    pausedAt: null,
    pausedByAccountId: null,
    ownBrand: false,
    lastChangedAt: START,
    version: 3,
    createdAt: START,
    publishedRevisionId: id<'ProductRevision'>(0xd001),
    pendingRevisionId: null,
    pendingSubmittedAt: null,
    variants: [],
  });
  const offerState = (code: string, overrides: Partial<OfferState> = {}): OfferState => ({
    id: OFFER,
    marketId: code as AccountState['marketId'],
    sellerId: SELLER,
    productId: PRODUCT,
    sellerSku: 'SKU-1',
    conditionCode: 'new',
    description: { 'en-AU': 'Fresh dates' },
    handling: 'SEALED_ORIGINAL',
    attestationRecordedAt: null,
    attestationAccountId: null,
    status: 'draft',
    offSaleCauses: [],
    listed: false,
    submittedAt: null,
    firstPublishedAt: null,
    deletedAt: null,
    version: 2,
    createdAt: START,
    ...overrides,
  });

  /** The owner and a second account of SELLER, and the owner of OTHER_SELLER. */
  const PEOPLE = [
    { account: OWNER, seller: SELLER, n: 1 },
    { account: OWNER_2, seller: SELLER, n: 2 },
    { account: OTHER_OWNER, seller: OTHER_SELLER, n: 3 },
  ] as const;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'preview-01'), {});
    const marketId = code as AccountState['marketId'];
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
    )!.id;
    for (const sellerId of [SELLER, OTHER_SELLER]) {
      fakes.seedSellerAccess({
        sellerId,
        marketId,
        origin: 'self',
        state: 'approved',
        stateChangedAt: START,
        reapplyCount: 0,
        registeredAt: START,
        version: 3,
        createdAt: START,
      });
    }
    for (const { account, seller, n } of PEOPLE) {
      fakes.seedAccount({
        id: account,
        marketId,
        population: 'seller',
        email: { typed: `Owner${n}@Example.com`, normalized: `owner${n}@example.com` },
        displayName: `Owner ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe000 + n),
        marketId,
        accountId: account,
        roleId: ownerRole,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
      fakes.seedMembership({
        id: id<'SellerMembership'>(0xf000 + n),
        marketId,
        accountId: account,
        sellerId: seller,
        state: 'active',
        removedAt: null,
        version: 1,
        createdAt: START,
      });
    }
  }

  let session: Record<string, string>;
  function sessionOf(code: string, who: (typeof PEOPLE)[number] = PEOPLE[0]) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf100 + who.n),
        marketId: code as AccountState['marketId'],
        accountId: who.account,
        population: 'seller',
        sellerId: who.seller,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }
  const post = (code: string, suffix: string, payload?: object) =>
    http()
      .post(`/catalog/seller/offers/${OFFER}${suffix}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...session })
      .send(payload);
  const preview = (code: string, payload?: object) => post(code, '/submit-preview', payload);

  /** Everything the submit writes; the preview must leave all of it empty. */
  const writes = () => ({
    saved: saved.length,
    events: events.length,
    audits: audits.length,
    referrals: referrals.length,
    postReviews: postReviews.rows.size,
    claimChecks,
    evaluated: evaluator.calls.length,
  });
  const NOTHING = {
    saved: 0,
    events: 0,
    audits: 0,
    referrals: 0,
    postReviews: 0,
    claimChecks: 0,
    evaluated: 0,
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    offer = null;
    saved = [];
    events = [];
    audits = [];
    referrals = [];
    postReviews = new InMemoryOfferPostReviews();
    counters = new MemoryRateCounters();
    reviewSettings = RISK_BASED;
    reviewFacts = CLEAN_FACTS;
    factReads = 0;
    eligible = true;
    allowed = 'all';
    forbidden = [];
    forbiddenCalls = forbidden;
    claimChecks = 0;
    evaluator = new FakeClaimEvaluator(() => {
      throw new Error('the preview never asks certification');
    }, ['halal']);
    productState = baseProduct;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('documents the route and its error codes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const responses =
      document.paths['/catalog/seller/offers/{offerId}/submit-preview']?.post?.responses;
    for (const status of ['200', '400', '401', '403', '404', '409', '422', '429', '503']) {
      expect(responses).toHaveProperty(status);
    }
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    beforeEach(async () => {
      await boot();
      await seeded(code);
      session = sessionOf(code);
      offer = Offer.restore(offerState(code));
      // Seeding the roles audits; only what the routes write counts.
      audits = [];
    });

    it('answers publish for a clean draft, no-store, and writes nothing', async () => {
      const response = await preview(code);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).toBe('{"outcome":"publish","reasons":[]}');
      expect(writes()).toEqual(NOTHING);
      expect(factReads).toBe(1);
      // Only the seller's two preview counters, on the seller (every account shares them).
      expect(counters.reserved.map((c) => c.map((x) => x.limit.kind))).toEqual([
        ['submit-preview.seller.minute', 'submit-preview.seller.day'],
      ]);
      const line = logLines.find((l) => l.msg === 'catalog.own-offer-submit-preview' && l.code);
      expect(line).toMatchObject({ code: 'publish', marketId: code });
    });

    it('answers a sampled and an unsampled Offer byte for byte the same, never asking the sampler (point 1)', async () => {
      // Off and risk-based publish, all queues: in each, the answer is one and the same whatever
      // the sampling percent, and the sampler (a tripwire here) is never reached.
      const byMode = new Map<string, Set<string>>();
      for (const mode of [REVIEW_OFF, RISK_BASED, { ...RISK_BASED, mode: 'all' as const }]) {
        for (const samplingPercent of [0, 5, 100]) {
          reviewSettings = { ...mode, samplingPercent };
          const response = await preview(code);
          const answers = byMode.get(mode.mode) ?? new Set<string>();
          answers.add(
            JSON.stringify([
              response.status,
              response.headers['content-type'],
              response.headers['cache-control'],
              response.text,
            ]),
          );
          byMode.set(mode.mode, answers);
        }
      }
      expect([...byMode.values()].map((answers) => answers.size)).toEqual([1, 1, 1]);
      expect([...byMode.get('all')!][0]).toContain('held-for-review');
      expect([...byMode.get('off')!][0]).toContain('publish');
      expect(forbidden).toEqual([]);
      expect(postReviews.rows.size).toBe(0);
    });

    it("never measures a price: pricing's R4 reference is not reached (point 2)", async () => {
      // A price inside the band, outside it or with no reference cannot change the answer: the
      // preview has no way to read it. The R4 ports are tripwires here.
      for (const settings of [REVIEW_OFF, RISK_BASED]) {
        reviewSettings = settings;
        expect((await preview(code)).text).toBe('{"outcome":"publish","reasons":[]}');
      }
      expect(forbidden).toEqual([]);
    });

    it('says one byte-identical held-for-review for R0, R1, R6, R7 and mode all (points 3, 4, 6)', async () => {
      const cases: [string, Partial<OfferReviewSettings>, Partial<OfferReviewFactsRead>][] = [
        ['market stop', { emergencyStop: true }, {}],
        ['seller or category stop', {}, { emergencyStop: true }],
        ['probation', {}, { probation: true }],
        ['full review or taken down', {}, { fullReview: true }],
        ['sensitive category', {}, { sensitiveCategory: true }],
        ['mode all', { mode: 'all' }, {}],
        [
          'every hidden reason at once',
          { emergencyStop: true, mode: 'all' },
          {
            emergencyStop: true,
            probation: true,
            fullReview: true,
            sensitiveCategory: true,
          },
        ],
      ];
      const texts = new Set<string>();
      for (const [, settings, facts] of cases) {
        reviewSettings = { ...RISK_BASED, ...settings };
        reviewFacts = { ...CLEAN_FACTS, ...facts };
        const response = await preview(code);
        expect(response.status).toBe(200);
        texts.add(response.text);
      }
      expect([...texts]).toEqual(['{"outcome":"review","reasons":["held-for-review"]}']);
      // Mode off still holds a stop, as the submit does, and names it the same way.
      reviewSettings = { ...REVIEW_OFF, emergencyStop: true };
      expect((await preview(code)).text).toBe('{"outcome":"review","reasons":["held-for-review"]}');
      expect(writes()).toEqual(NOTHING);
    });

    it('names handling, a badge and contact text, never the matched text (point 5)', async () => {
      offer = Offer.restore(offerState(code, { handling: 'REPACKED' }));
      expect((await preview(code)).body).toEqual({ outcome: 'review', reasons: ['handling'] });

      offer = Offer.restore(offerState(code));
      const badge = await preview(code, { requestedTags: ['halal'] });
      expect(badge.body).toEqual({ outcome: 'review', reasons: ['certificate-badge'] });

      const phone = '0412 345 678';
      offer = Offer.restore(
        offerState(code, {
          description: { 'en-AU': `Fresh dates, call ${phone} or shop.example.com` },
        }),
      );
      const contact = await preview(code);
      expect(contact.body).toEqual({ outcome: 'review', reasons: ['contact-text'] });
      expect(contact.text).not.toMatch(/0412|345|678|example|call|shop/);
      const line = logLines.filter((l) => l.msg === 'catalog.own-offer-submit-preview');
      expect(JSON.stringify(line)).not.toMatch(/0412|example|contact-text|handling|badge/);

      // A told reason beside a hidden one: the told one by name, the rest as one.
      reviewFacts = { ...CLEAN_FACTS, sensitiveCategory: true, probation: true };
      offer = Offer.restore(offerState(code, { handling: 'FRESH' }));
      expect((await preview(code)).body).toEqual({
        outcome: 'review',
        reasons: ['handling', 'held-for-review'],
      });
      // The same list when the hidden reason sorts after handling in the policy (R6, R7) as
      // before it (R0, R1): its position tells nothing.
      reviewFacts = { ...CLEAN_FACTS, emergencyStop: true };
      expect((await preview(code)).text).toBe(
        '{"outcome":"review","reasons":["handling","held-for-review"]}',
      );
      expect(writes()).toEqual(NOTHING);
    });

    it('gives the same answer as the real submit, whose reasons it is (parity)', async () => {
      const cases: [
        Partial<OfferState>,
        Partial<OfferReviewSettings>,
        Partial<OfferReviewFactsRead>,
      ][] = [
        [{}, {}, {}],
        [{ handling: 'PREPARED' }, {}, {}],
        [{}, {}, { probation: true }],
        [{}, { mode: 'off' }, { sensitiveCategory: true }],
        [{}, { mode: 'all' }, {}],
        [{ description: { 'en-AU': 'DM me on insta' } }, {}, { fullReview: true }],
      ];
      for (const [state, settings, facts] of cases) {
        reviewSettings = { ...RISK_BASED, ...settings };
        reviewFacts = { ...CLEAN_FACTS, ...facts };
        offer = Offer.restore(offerState(code, state));
        const previewed = (await preview(code)).body as { outcome: string; reasons: string[] };
        const before = referrals.length;
        const submitted = (await post(code, '/submit')).body as { published: boolean };
        // The submit recorded its own referral: the comparison never reads a stale one.
        expect(referrals.length).toBe(before + 1);
        const referral = referrals.at(-1)!;
        expect([previewed.outcome === 'publish', previewed.reasons]).toEqual([
          submitted.published,
          [...sellerReviewReasonsOf(referral.reasons)],
        ]);
      }
    });

    it('answers 503 when a fact or the settings could not be read, never a guess (point 7)', async () => {
      reviewFacts = { ...CLEAN_FACTS, degraded: true };
      const facts = await preview(code);
      expect([facts.status, facts.body]).toEqual([
        503,
        { statusCode: 503, code: 'access.unavailable' },
      ]);

      reviewFacts = CLEAN_FACTS;
      reviewSettings = SAFE_OFFER_REVIEW_SETTINGS;
      const settings = await preview(code);
      expect([settings.status, settings.text]).toEqual([facts.status, facts.text]);
      expect(writes()).toEqual(NOTHING);
    });

    it('keeps the submit guards: byte-identical 404, 409 not a draft, 422 no handling', async () => {
      const bodies = new Set<string>();
      for (const other of [
        null,
        offerState(code, { sellerId: OTHER_SELLER }),
        offerState(code, { status: 'deleted' }),
      ]) {
        offer = other === null ? null : Offer.restore(other);
        const response = await preview(code);
        expect(response.status).toBe(404);
        bodies.add(response.text);
      }
      expect(bodies.size).toBe(1);

      offer = Offer.restore(
        offerState(code, { status: 'pending-first-publish', submittedAt: START }),
      );
      expect((await preview(code)).body).toEqual({
        statusCode: 409,
        code: 'offer.not-submittable',
      });
      offer = Offer.restore(offerState(code, { handling: null }));
      expect((await preview(code)).body).toEqual({
        statusCode: 422,
        code: 'offer.handling-missing',
      });
      productState = (m) => ({ ...baseProduct(m), pausedAt: START });
      offer = Offer.restore(offerState(code));
      expect((await preview(code)).body).toEqual({
        statusCode: 409,
        code: 'offer.product-not-published',
      });
      // None of these judged the Offer.
      expect(factReads).toBe(0);

      const unknownKey = await preview(code, { requestedTags: ['halal'], decision: 'allowed' });
      expect(unknownKey.status).toBe(400);
      expect(writes()).toEqual(NOTHING);
    });

    it('limits a seller to 10 previews a minute (429 with Retry-After), then lets it go on', async () => {
      for (let n = 0; n < 10; n += 1) expect((await preview(code)).status).toBe(200);
      const throttled = await preview(code);
      expect(throttled.status).toBe(429);
      expect(throttled.body).toMatchObject({ code: 'request.throttled' });
      expect(Number(throttled.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      // A throttled preview reads nothing about the Offer.
      expect(factReads).toBe(10);

      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      expect((await preview(code)).status).toBe(200);
    });

    it('caps a seller at 200 previews a day, across minutes', async () => {
      // 200 real requests would meet the platform's per-origin limit first, so the day counter is
      // brought to 199 directly after the first preview made it.
      expect((await preview(code)).status).toBe(200);
      const day = [...counters.counts.entries()].find(([key]) =>
        key.startsWith('submit-preview.seller.day:'),
      )!;
      day[1].count = 199;
      clock.advance(Temporal.Duration.from({ minutes: 5 }));
      expect((await preview(code)).status).toBe(200);
      const throttled = await preview(code);
      expect(throttled.status).toBe(429);
      // The day window, not the minute one: about 24 hours less the 5 minutes gone.
      expect(Number(throttled.headers['retry-after'])).toBe(24 * 3600 - 5 * 60);
      clock.advance(Temporal.Duration.from({ hours: 24 }));
      session = sessionOf(code);
      expect((await preview(code)).status).toBe(200);
    });

    it('shares the budget between the accounts of one seller, never with another seller', async () => {
      const second = sessionOf(code, PEOPLE[1]);
      for (let n = 0; n < 10; n += 1) {
        session = n % 2 === 0 ? sessionOf(code, PEOPLE[0]) : second;
        expect((await preview(code)).status).toBe(200);
      }
      session = second;
      expect((await preview(code)).status).toBe(429);
      // Another seller has its own budget: its answer for this Offer is the not-found of an
      // Offer it does not own, never a throttle.
      session = sessionOf(code, PEOPLE[2]);
      const other = await preview(code);
      expect([other.status, other.body]).toEqual([
        404,
        { statusCode: 404, code: 'offer.not-found' },
      ]);
    });

    it('fails closed: counters, badge types and allowed types unreadable are 503; a seller who may not sell is 403', async () => {
      const failing = counters.reserve.bind(counters);
      counters.reserve = () => Promise.reject(new Error('counters down'));
      const noCounters = await preview(code);
      expect([noCounters.status, noCounters.body]).toEqual([
        503,
        { statusCode: 503, code: 'access.unavailable' },
      ]);
      counters.reserve = failing;

      evaluator.activeUnavailable = true;
      const noTypes = await preview(code, { requestedTags: ['halal'] });
      expect([noTypes.status, noTypes.body]).toEqual([
        503,
        { statusCode: 503, code: 'claim.check-unavailable' },
      ]);
      evaluator.activeUnavailable = false;
      expect((await preview(code, { requestedTags: ['kosher-x'] })).body).toEqual({
        statusCode: 422,
        code: 'tag.type-unknown',
      });

      allowed = null;
      expect((await preview(code)).status).toBe(503);
      allowed = new Set(['other-type']);
      expect((await preview(code)).body).toEqual({ statusCode: 422, code: 'type.not-allowed' });
      allowed = 'all';

      eligible = false;
      expect((await preview(code)).body).toEqual({ statusCode: 403, code: 'seller.not-eligible' });
      // None of these was judged, and nothing was written.
      expect(factReads).toBe(0);
      expect(writes()).toEqual(NOTHING);
    });
  });
});
