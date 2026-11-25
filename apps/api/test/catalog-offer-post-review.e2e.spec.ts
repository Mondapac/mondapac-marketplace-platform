import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, PendingEvent } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { OFFER_PENDING_CHANGE_REPOSITORY } from '../src/modules/catalog/application/ports/offer-pending-change.repository';
import { OFFER_POST_REVIEW_REPOSITORY } from '../src/modules/catalog/application/ports/offer-post-review';
import { OFFER_REPOSITORY } from '../src/modules/catalog/application/ports/offer.repository';
import { OWN_CATALOG_READER } from '../src/modules/catalog/application/ports/own-catalog.reader';
import { SELLER_NAMES_READER } from '../src/modules/catalog/application/ports/seller-names.reader';
import { SELLER_OFFER_REVIEW_FLAGS_READER } from '../src/modules/catalog/application/ports/seller-offer-review-flags.reader';
import { SELLER_REVIEW_STANDING_REPOSITORY } from '../src/modules/catalog/application/ports/seller-review-standing.repository';
import { Offer, type OfferState } from '../src/modules/catalog/domain/offer';
import { OfferPostReview } from '../src/modules/catalog/domain/offer-post-review';
import { OFFER_POST_REVIEW_STATUS } from '../src/modules/catalog/presentation/offer-post-review.controller';
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
import { InMemoryOfferPendingChanges } from './support/catalog-offer-edit-review-fakes';
import { InMemoryOfferPostReviews } from './support/catalog-offer-post-review-fakes';
import { FLAGS_OFF, InMemorySellerReviewStandings } from './support/catalog-seller-review-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The post-publication review list over HTTP (risk-based Offer approval slice 6): the real
// guards, controller, gate and use cases, with identity's ports and catalog's stores as in-memory
// fakes. Proved here: the admin session and CSRF token, the keys (the seeded Moderator holds
// view, approve and delete; the Viewer view only; a custom role none), the closed bodies, the
// status of each refusal, no-store, the shapes the admin panel reads, and the note shown only to
// an approver and never logged.

const START = Temporal.Instant.from('2026-11-25T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const NOTE = 'Secret reviewer note 4471';

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const NO_KEY = id<'Account'>(0xa003);
const NO_KEY_ROLE = id<'Role'>(0xc0f2);
const SELLER = id<'Seller'>(0xb020);
const PRODUCT = id<'Product'>(0xc001);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the post-review use cases to its exact status', () => {
  expect(OFFER_POST_REVIEW_STATUS).toEqual({
    'validation.failed': 400,
    'post-review.not-found': 404,
    'post-review.not-open': 409,
    'offer.not-live': 409,
    'conflict.stale': 409,
    'post-review.own-submission': 403,
    'batch.too-large': 413,
    'access.unavailable': 503,
  });
});

describe('admin post-publication review over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let offers: Map<string, OfferState>;
  let events: PendingEvent[];
  let audits: { action: string }[];
  let postReviews: InMemoryOfferPostReviews;
  let pendingChanges: InMemoryOfferPendingChanges;
  let standings: InMemorySellerReviewStandings;
  let logLines: LogLine[];
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
            append: (_c: CallContext, pending: readonly PendingEvent[]) => {
              events.push(...pending);
              return Promise.resolve();
            },
          })
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({
            findById: (_m: MarketContext, offerId: Id<'Offer'>) =>
              Promise.resolve(offers.has(offerId) ? Offer.restore(offers.get(offerId)!) : null),
            findManyByIds: (m: MarketContext, wanted: readonly Id<'Offer'>[]) =>
              Promise.resolve(
                wanted.flatMap((offerId) => {
                  const state = offers.get(offerId);
                  return state !== undefined && state.marketId === m.marketId
                    ? [Offer.restore(state)]
                    : [];
                }),
              ),
            save: (_m: MarketContext, offer: Offer) => {
              offers.set(offer.state.id, offer.state);
              return Promise.resolve(null);
            },
          })
          .overrideProvider(OWN_CATALOG_READER)
          .useValue({
            productLabels: () =>
              Promise.resolve([
                { productId: PRODUCT, productCode: 'P00000001', typeCode: 'simple', name: 'Dates' },
              ]),
          })
          .overrideProvider(SELLER_NAMES_READER)
          .useValue({ storeNames: () => Promise.resolve(new Map([[SELLER, 'Dates Co']])) })
          .overrideProvider(OFFER_POST_REVIEW_REPOSITORY)
          .useValue(postReviews)
          .overrideProvider(OFFER_PENDING_CHANGE_REPOSITORY)
          .useValue(pendingChanges)
          .overrideProvider(SELLER_REVIEW_STANDING_REPOSITORY)
          .useValue(standings)
          .overrideProvider(SELLER_OFFER_REVIEW_FLAGS_READER)
          .useValue({ flagsOf: () => Promise.resolve(FLAGS_OFF) })
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

  /** A published, listed Offer and its open row (reason `sample` at 5%). */
  function liveRow(code: string, n: number) {
    const offerId = id<'Offer'>(0x9000 + n);
    offers.set(offerId, {
      id: offerId,
      marketId: code as AccountState['marketId'],
      sellerId: SELLER,
      productId: PRODUCT,
      sellerSku: `SKU-${n}`,
      conditionCode: 'new',
      description: { 'en-AU': 'Fresh dates' },
      handling: 'SEALED_ORIGINAL',
      attestationRecordedAt: null,
      attestationAccountId: null,
      status: 'published',
      offSaleCauses: [],
      listed: true,
      submittedAt: START,
      firstPublishedAt: START,
      deletedAt: null,
      version: 4,
      createdAt: START,
    });
    const opened = OfferPostReview.open({
      id: id<'OfferPostReview'>(0x7000 + n),
      marketId: code as AccountState['marketId'],
      offerId,
      sellerId: SELLER,
      productId: PRODUCT,
      reason: 'sample',
      sample: { percent: 5, doubled: false },
      now: START.add({ minutes: n }),
    });
    if (!opened.ok) throw new Error(opened.error.code);
    postReviews.rows.set(opened.value.state.id, opened.value.state);
    return opened.value.state;
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'review-0001'), {});
    const marketId = code as AccountState['marketId'];
    fakes.seedRole({
      id: NO_KEY_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'No catalog key',
      permissionKeys: ['identity.admin-account.view'],
      version: 1,
      createdAt: START,
    });
    const seedRole = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    let n = 0;
    const admin = (accountId: Id<'Account'>, label: string, roleId: Id<'Role'>) => {
      n += 1;
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'admin',
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: `Name ${label}`,
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
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(MODERATOR, 'moderator', seedRole('catalogue-moderator'));
    admin(VIEWER, 'viewer', seedRole('viewer'));
    admin(NO_KEY, 'nokey', NO_KEY_ROLE);
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const base = (code: string) => ({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
  const get = (code: string, path: string, session: Record<string, string>) =>
    http()
      .get(`/catalog/admin/offer-post-reviews${path}`)
      .set({ ...base(code), cookie: session.cookie! });
  const post = (code: string, path: string, session: Record<string, string>, payload?: unknown) =>
    http()
      .post(`/catalog/admin/offer-post-reviews${path}`)
      .set({ ...base(code), ...session })
      .send(payload ?? {});

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START.add({ hours: 1 }));
    offers = new Map();
    events = [];
    audits = [];
    postReviews = new InMemoryOfferPostReviews();
    pendingChanges = new InMemoryOfferPendingChanges();
    standings = new InMemorySellerReviewStandings();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('documents the routes, their bodies and their error codes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const root = '/catalog/admin/offer-post-reviews';
    const routes: [string, string, string[]][] = [
      [root, 'get', ['200', '400', '401', '403', '503']],
      [`${root}/export`, 'get', ['200', '400', '403', '413', '503']],
      [`${root}/bulk-approve`, 'post', ['200', '400', '403', '503']],
      [`${root}/{id}`, 'get', ['200', '400', '403', '404', '503']],
      [`${root}/{id}/approve`, 'post', ['200', '400', '403', '404', '409', '503']],
      [`${root}/{id}/take-down`, 'post', ['200', '400', '403', '404', '409', '503']],
    ];
    for (const [path, method, statuses] of routes) {
      const responses = document.paths[path]?.[method]?.responses;
      for (const status of statuses)
        expect([path, method, responses]).toEqual([
          path,
          method,
          expect.objectContaining({ [status]: expect.anything() as unknown }),
        ]);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the open rows with the shape the admin panel reads, no-store, never the note', async () => {
      await boot();
      await seeded(code);
      const row = liveRow(code, 1);
      const response = await get(code, '', sessionOf(code, MODERATOR, 1));
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as Record<string, unknown> & { items: Record<string, unknown>[] };
      expect(Object.keys(body).sort()).toEqual(
        [
          'items',
          'page',
          'pageSize',
          'paging',
          'hasNext',
          'total',
          'totalOpen',
          'searchCapped',
          'sellers',
          'sellersCapped',
        ].sort(),
      );
      expect(body.totalOpen).toBe(1);
      expect(body.items).toEqual([
        {
          id: row.id,
          version: 1,
          status: 'open',
          reasons: ['sample'],
          samplePercent: 5,
          sampleDoubled: false,
          openedAt: row.openedAt.toString(),
          decidedAt: null,
          decision: null,
          offer: { id: row.offerId, status: 'published', listed: true, sellerSku: 'SKU-1' },
          product: { id: PRODUCT, name: 'Dates' },
          sellerId: SELLER,
          storeName: 'Dates Co',
          actions: { approve: true, takeDown: true },
        },
      ]);
      expect(body.items[0]).not.toHaveProperty('note');
    });

    it('lets a Viewer read without the decision actions, and refuses a role with no key', async () => {
      await boot();
      await seeded(code);
      liveRow(code, 1);
      const viewer = await get(code, '', sessionOf(code, VIEWER, 1));
      expect(viewer.status).toBe(200);
      expect((viewer.body as { items: { actions: unknown }[] }).items[0]!.actions).toEqual({
        approve: false,
        takeDown: false,
      });
      const none = await get(code, '', sessionOf(code, NO_KEY, 2));
      expect(none.status).toBe(403);
    });

    it('shows the note to an approver only, after the decision', async () => {
      await boot();
      await seeded(code);
      const row = liveRow(code, 1);
      const moderator = sessionOf(code, MODERATOR, 1);
      const approved = await post(code, `/${row.id}/approve`, moderator, {
        version: 1,
        note: NOTE,
      });
      expect(approved.status).toBe(200);
      expect(approved.body).toEqual({
        id: row.id,
        offerId: row.offerId,
        status: 'approved',
        version: 2,
      });
      const asModerator = await get(code, `/${row.id}`, moderator);
      expect(asModerator.status).toBe(200);
      expect(asModerator.body).toMatchObject({ status: 'approved', note: NOTE });
      const asViewer = await get(code, `/${row.id}`, sessionOf(code, VIEWER, 2));
      expect(asViewer.body).toMatchObject({ status: 'approved', note: null });
      // Never logged or audited.
      expect(JSON.stringify([logLines, audits])).not.toContain('4471');
      expect(
        logLines.find((line) => line.msg === 'catalog.offer-post-review-approve'),
      ).toMatchObject({ marketId: code });
    });

    it('takes an Offer down: off sale, changes needed, the seller notice and the listing event', async () => {
      await boot();
      await seeded(code);
      const row = liveRow(code, 1);
      const response = await post(code, `/${row.id}/take-down`, sessionOf(code, MODERATOR, 1), {
        version: 1,
        reasonCode: 'description-claim',
        misconduct: false,
        note: NOTE,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: row.id,
        offerId: row.offerId,
        status: 'taken-down',
        version: 2,
      });
      expect(offers.get(row.offerId)).toMatchObject({ status: 'changes-needed', listed: false });
      expect(events.map((e) => e.type)).toEqual([
        'catalog.offer-changes-requested.v1',
        'catalog.offer-listing-changed.v1',
      ]);
      expect(audits.map((a) => a.action).filter((a) => a.startsWith('catalog.'))).toEqual([
        'catalog.offer.taken-down',
      ]);
      expect(JSON.stringify([logLines, audits, events])).not.toContain('4471');
      // A second decision on the row: 409.
      const again = await post(code, `/${row.id}/approve`, sessionOf(code, MODERATOR, 2), {
        version: 2,
      });
      expect([again.status, (again.body as { code: string }).code]).toEqual([
        409,
        'post-review.not-open',
      ]);
    });

    it('refuses the decisions without their keys, a closed body, a stale version and an unknown row', async () => {
      await boot();
      await seeded(code);
      const row = liveRow(code, 1);
      const viewer = sessionOf(code, VIEWER, 1);
      const moderator = sessionOf(code, MODERATOR, 2);
      expect((await post(code, `/${row.id}/approve`, viewer, { version: 1 })).status).toBe(403);
      expect(
        (
          await post(code, `/${row.id}/take-down`, viewer, {
            version: 1,
            reasonCode: 'other',
            misconduct: false,
            note: 'x',
          })
        ).status,
      ).toBe(403);
      expect(
        (await post(code, '/bulk-approve', viewer, { items: [{ id: row.id, version: 1 }] })).status,
      ).toBe(403);
      const extra = await post(code, `/${row.id}/approve`, moderator, {
        version: 1,
        misconduct: 1,
      });
      expect(extra.status).toBe(400);
      const stale = await post(code, `/${row.id}/approve`, moderator, { version: 7 });
      expect([stale.status, (stale.body as { code: string }).code]).toEqual([
        409,
        'conflict.stale',
      ]);
      const unknown = await post(code, `/${id<'OfferPostReview'>(0x7999)}/approve`, moderator, {
        version: 1,
      });
      expect(unknown.status).toBe(404);
      const noNote = await post(code, `/${row.id}/take-down`, moderator, {
        version: 1,
        reasonCode: 'other',
        misconduct: false,
      });
      expect(noNote.status).toBe(400);
      // A missing CSRF token is refused before any use case.
      const noCsrf = await http()
        .post(`/catalog/admin/offer-post-reviews/${row.id}/approve`)
        .set({ ...base(code), cookie: moderator.cookie })
        .send({ version: 1 });
      expect(noCsrf.status).toBe(403);
      expect(postReviews.rows.get(row.id)?.status).toBe('open');
    });

    it('refuses the decider their own submission (403)', async () => {
      await boot();
      await seeded(code);
      const row = liveRow(code, 1);
      postReviews.submitters.set(row.offerId, new Set([MODERATOR]));
      const response = await post(code, `/${row.id}/approve`, sessionOf(code, MODERATOR, 1), {
        version: 1,
      });
      expect([response.status, (response.body as { code: string }).code]).toEqual([
        403,
        'post-review.own-submission',
      ]);
    });

    it('bulk-approves with counts and one result per row in the order given', async () => {
      await boot();
      await seeded(code);
      const first = liveRow(code, 1);
      const second = liveRow(code, 2);
      const response = await post(code, '/bulk-approve', sessionOf(code, MODERATOR, 1), {
        items: [
          { id: first.id, version: 1 },
          { id: second.id, version: 9 },
        ],
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        counts: { done: 1, skipped: 1, failed: 0 },
        results: [
          { id: first.id, outcome: 'done', name: 'Dates' },
          { id: second.id, outcome: 'skipped', reason: 'conflict.stale', name: 'Dates' },
        ],
      });
    });

    it('never shows a row of another Market', async () => {
      await boot();
      await seeded(code);
      const other = code === 'AU' ? 'ZZ' : 'AU';
      const row = liveRow(other, 1);
      const list = await get(code, '', sessionOf(code, MODERATOR, 1));
      expect((list.body as { items: unknown[]; totalOpen: number }).items).toEqual([]);
      expect((list.body as { totalOpen: number }).totalOpen).toBe(0);
      expect((await get(code, `/${row.id}`, sessionOf(code, MODERATOR, 2))).status).toBe(404);
    });

    it('exports the rows as CSV without the note', async () => {
      await boot();
      await seeded(code);
      liveRow(code, 1);
      const response = await get(code, '/export?format=csv', sessionOf(code, MODERATOR, 1));
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).toContain('SKU-1');
      expect(response.text).not.toContain('4471');
    });
  });
});
