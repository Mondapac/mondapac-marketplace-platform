import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, Id, MarketId } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CATEGORY_OFFER_REVIEW_FLAGS_STORE } from '../src/modules/catalog/application/ports/category-offer-review-flags.store';
import { OFFER_REVIEW_INPUTS } from '../src/modules/catalog/application/ports/offer-review';
import { SELLER_OFFER_REVIEW_FLAGS_READER } from '../src/modules/catalog/application/ports/seller-offer-review-flags.reader';
import { SELLER_REVIEW_STANDING_REPOSITORY } from '../src/modules/catalog/application/ports/seller-review-standing.repository';
import { SellerReviewStanding } from '../src/modules/catalog/domain/seller-review-standing';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { AUDIT_WRITER } from '../src/platform/audit/audit-writer';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import {
  FLAGS_OFF,
  InMemoryCategoryOfferReviewFlags,
  InMemorySellerReviewStandings,
} from './support/catalog-seller-review-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin routes of slice 4 of risk-based Offer approval over HTTP: a seller's review standing
// and the Offer review flags of platform categories ("always review", the category stop), with
// the real guards, controller, gate and use cases on both Market fixtures. Identity's ports and
// catalog's stores are in-memory fakes (the SQL is test/db/offer-review-probation.db-spec.ts).

const START = Temporal.Instant.from('2026-11-25T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xb000 + n)}`);
const sessionId = (n: number) => `01990000-0000-7000-8000-${n12(0xf200 + n)}`;
const SELLER = id<'Seller'>(`01990000-0000-7000-8000-${n12(0xc001)}`);
const CATEGORY = id<'Category'>(`01990000-0000-7000-8000-${n12(0xd001)}`);
const ROOT = accountId(1);
const VIEWER = accountId(2);
const CANARY = 'canary-reason-bilby';

const STEP_UP = {
  'offer-review': 'catalog.category-review.change',
  'offer-review-stop': 'catalog.offer-review-stop.change',
} as const;
type Route = keyof typeof STEP_UP;

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('catalog Offer review flags and standing over HTTP (integration, slice 4)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let store: InMemoryCategoryOfferReviewFlags;
  let standings: InMemorySellerReviewStandings;
  let audits: AuditEntry[];
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
          .overrideProvider(CATEGORY_OFFER_REVIEW_FLAGS_STORE)
          .useValue(store)
          .overrideProvider(SELLER_REVIEW_STANDING_REPOSITORY)
          .useValue(standings)
          .overrideProvider(SELLER_OFFER_REVIEW_FLAGS_READER)
          .useValue({ flagsOf: () => Promise.resolve(FLAGS_OFF) })
          .overrideProvider(OFFER_REVIEW_INPUTS)
          .useValue({
            settings: () =>
              Promise.resolve({
                mode: 'risk-based',
                certificateBadges: 'review',
                emergencyStop: false,
              }),
            probationOffers: () => Promise.resolve(2),
            facts: () => Promise.reject(new Error('not used')),
          })
          .overrideProvider(AUDIT_WRITER)
          .useValue({
            record: (_c: unknown, entry: AuditEntry) => {
              audits.push(entry);
              return Promise.resolve();
            },
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const roleOf = (code: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
    )!.id;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'acts-0001'), {});
    const marketId = code as AccountState['marketId'];
    for (const [n, idOf, seedCode] of [
      [1, ROOT, 'platform-administrator'],
      [2, VIEWER, 'viewer'],
    ] as const) {
      fakes.seedAccount({
        id: idOf,
        marketId,
        population: 'admin',
        email: { typed: `Person${n}@Example.com`, normalized: `person${n}@example.com` },
        displayName: `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe200 + n)}`),
        marketId,
        accountId: idOf,
        roleId: roleOf(code, seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
      fakes.factors.set(idOf, {
        id: id<'SecondFactor'>(`01990000-0000-7000-8000-${n12(0xf300 + n)}`),
        marketId,
        accountId: idOf,
        state: 'active',
        secretCiphertext: 'sealed',
        pendingSecretCiphertext: null,
        lastAcceptedStep: null,
        activatedAt: START,
        lockedAt: null,
        createdAt: START,
        recoveryCodes: Array.from({ length: 10 }, (_, index) => ({
          position: index + 1,
          codeHash: new Uint8Array(32).fill(index + 1),
          usedAt: null,
        })),
        version: 1,
      });
    }
  }

  function sessionHeaders(code: string, account: Id<'Account'>, n: number, { proved = true } = {}) {
    const issued = tokens.issue();
    if (proved) {
      for (const action of Object.values(STEP_UP)) {
        fakes.stepUpProofs.set(`${code}|${sessionId(n)}|${action}`, clock.now());
      }
    }
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(sessionId(n)),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        sellerId: null,
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

  const headersOf = (code: string) => ({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
  const get = (code: string, path: string, headers: Record<string, string> | null) => {
    const call = http().get(`/catalog/admin${path}`).set(headersOf(code));
    return headers === null ? call : call.set('cookie', headers.cookie!);
  };
  const put = (
    code: string,
    route: Route,
    category: string,
    headers: Record<string, string> | null,
    body: unknown,
  ) => {
    const call = http().put(`/catalog/admin/categories/${category}/${route}`).set(headersOf(code));
    if (headers === null) return call.send(body as object);
    return call.set(headers).send(body as object);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    store = new InMemoryCategoryOfferReviewFlags();
    standings = new InMemorySellerReviewStandings();
    audits = [];
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the four routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.paths['/catalog/admin/sellers/{sellerId}/review-standing']).toHaveProperty(
      'get',
    );
    expect(document.paths['/catalog/admin/offer-review/category-flags']).toHaveProperty('get');
    for (const route of Object.keys(STEP_UP)) {
      expect(document.paths[`/catalog/admin/categories/{categoryId}/${route}`]).toHaveProperty(
        'put',
      );
    }
    for (const schema of [
      'SellerReviewStandingDto',
      'FlaggedCategoriesDto',
      'CategoryOfferReviewFlagRequest',
      'CategoryOfferReviewFlagChangedDto',
    ]) {
      expect(document.components.schemas).toHaveProperty([schema]);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const other = TEST_MARKETS.find((m) => m !== code)!;

    it.each(Object.keys(STEP_UP) as Route[])(
      'switches %s on, lists the category, never logs the reason',
      async (route) => {
        await boot();
        await seeded(code);
        store.addCategory(marketOf(code), CATEGORY);

        const changed = await put(code, route, CATEGORY, sessionHeaders(code, ROOT, 1), {
          on: true,
          reason: CANARY,
          expectedVersion: 0,
        });
        expect(changed.status).toBe(200);
        expect(changed.headers['cache-control']).toBe('no-store');
        expect(changed.body).toEqual({ on: true, changed: true, version: 1 });

        const listed = await get(
          code,
          '/offer-review/category-flags',
          sessionHeaders(code, ROOT, 2),
        );
        expect(listed.status).toBe(200);
        expect(listed.body).toEqual({
          items: [
            {
              categoryId: CATEGORY,
              alwaysReview: route === 'offer-review',
              reviewStop: route === 'offer-review-stop',
              alwaysReviewChangedAt: route === 'offer-review' ? START.toString() : null,
              reviewStopChangedAt: route === 'offer-review-stop' ? START.toString() : null,
              version: 1,
            },
          ],
        });
        expect(store.changes).toEqual([expect.objectContaining({ reason: CANARY })]);
        const catalogAudits = audits.filter((a) => a.action.startsWith('catalog.'));
        expect(catalogAudits).toEqual([
          expect.objectContaining({
            targetId: CATEGORY,
            before: { on: false },
            after: { on: true, stepUpVerifiedAt: START },
          }),
        ]);
        expect(JSON.stringify(audits)).not.toContain(CANARY);
        expect(JSON.stringify(logLines)).not.toContain(CANARY);

        const stale = await put(code, route, CATEGORY, sessionHeaders(code, ROOT, 3), {
          on: false,
          reason: 'x',
          expectedVersion: 0,
        });
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ code: 'conflict.stale' });
      },
    );

    it.each(Object.keys(STEP_UP) as Route[])(
      'refuses %s without a fresh two-step proof: 403 second-factor.required with the action key',
      async (route) => {
        await boot();
        await seeded(code);
        store.addCategory(marketOf(code), CATEGORY);
        const refused = await put(
          code,
          route,
          CATEGORY,
          sessionHeaders(code, ROOT, 4, { proved: false }),
          { on: true, reason: 'x', expectedVersion: 0 },
        );
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({
          code: 'second-factor.required',
          details: { actionKey: STEP_UP[route] },
        });
        expect(store.rows.size).toBe(0);
      },
    );

    it('answers validation.failed, 404 for another Market, and refuses a Viewer and a visitor', async () => {
      await boot();
      await seeded(code);
      store.addCategory(marketOf(other), CATEGORY);
      const bad = await put(code, 'offer-review', CATEGORY, sessionHeaders(code, ROOT, 5), {
        on: true,
        expectedVersion: 0,
      });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'reason', code: 'required' }] },
      });
      const foreign = await put(code, 'offer-review', CATEGORY, sessionHeaders(code, ROOT, 6), {
        on: true,
        reason: 'x',
        expectedVersion: 0,
      });
      expect(foreign.status).toBe(404);
      expect(foreign.body).toMatchObject({ code: 'category.not-found' });
      const body = { on: true, reason: 'x', expectedVersion: 0 };
      for (const route of Object.keys(STEP_UP) as Route[]) {
        const viewer = await put(code, route, CATEGORY, sessionHeaders(code, VIEWER, 7), body);
        expect(viewer.status).toBe(403);
        expect(viewer.body).toMatchObject({ code: 'access.denied' });
        expect((await put(code, route, CATEGORY, null, body)).status).toBe(401);
      }
      expect(store.rows.size).toBe(0);
    });

    it("reads a seller's standing: count, target and Trusted, never another Market's", async () => {
      await boot();
      await seeded(code);
      const path = `/sellers/${SELLER}/review-standing`;
      const none = await get(code, path, sessionHeaders(code, ROOT, 8));
      expect(none.status).toBe(200);
      expect(none.headers['cache-control']).toBe('no-store');
      expect(none.body).toMatchObject({
        status: 'probation',
        count: 0,
        target: 2,
        probationOffers: 2,
        epoch: 0,
        flags: { trustedFromStart: { on: false, at: null } },
      });

      standings.rows.set(`${code}|${SELLER}`, {
        ...SellerReviewStanding.start({ marketId: code as MarketId, sellerId: SELLER, now: START })
          .state,
        trustedAt: START,
      });
      const trusted = await get(code, path, sessionHeaders(code, ROOT, 9));
      expect(trusted.body).toMatchObject({
        status: 'trusted',
        source: 'count',
        trustedSince: START.toString(),
        epoch: 1,
      });
      expect((await get(code, path, sessionHeaders(code, VIEWER, 11))).status).toBe(403);
      expect(
        (await get(code, '/sellers/nope/review-standing', sessionHeaders(code, ROOT, 12))).status,
      ).toBe(404);
      // The other Market's admins (the same account ids, seeded there) see no standing there.
      await seeded(other);
      const foreign = await get(other, path, sessionHeaders(other, ROOT, 10));
      expect(foreign.status).toBe(200);
      expect(foreign.body).toMatchObject({ status: 'probation', epoch: 0, count: 0 });
    });
  });
});
