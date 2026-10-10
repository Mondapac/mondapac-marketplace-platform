import type { NestExpressApplication } from '@nestjs/platform-express';
import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { PRICE_SERIES_REPOSITORY } from '../src/modules/pricing/application/ports/price-series.repository';
import { priceAmount } from '../src/modules/pricing/domain/price-amount';
import { PriceSeries } from '../src/modules/pricing/domain/price-series';
import { PRICE_HOLD_STATUS } from '../src/modules/pricing/presentation/admin-price-hold.controller';
import { AUDIT_WRITER } from '../src/platform/audit/audit-writer';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import {
  FakeUnitOfWork,
  InMemoryPriceSeries,
  RecordingAuditWriter,
  RecordingOutbox,
} from './support/pricing-fakes';
import { PRICING_FIXTURES } from './support/pricing-fixtures';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin price-hold review over HTTP (pricing slice 4): the real guards, controller, gate and
// use cases, with identity's ports and pricing's stores as in-memory fakes. Proved here: the
// session and the CSRF token, the two keys (the protected decide key included), the Market
// scope, the closed body, the status of each refusal, no-store and the log line.

const START = Temporal.Instant.from('2026-10-10T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const DECIDER = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const NO_KEY = id<'Account'>(0xa003);
const SELLER_ACCOUNT = id<'Account'>(0xa101);
const SELLER = id<'Seller'>(0xb020);
const DECIDER_ROLE = id<'Role'>(0xc0f1);
const NO_KEY_ROLE = id<'Role'>(0xc0f2);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the review use cases to its exact status', () => {
  expect(PRICE_HOLD_STATUS).toEqual({
    'validation.failed': 400,
    'pricing.hold.not-found': 404,
    'pricing.hold.not-pending': 409,
    'pricing.hold.own-submission': 403,
    'pricing.series-retired': 409,
    'pricing.amount-out-of-range': 422,
    'pricing.currency-mismatch': 422,
    'conflict.stale': 409,
    'conflict.retry': 409,
  });
});

describe('admin price holds over HTTP (integration, pricing slice 4)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let clock: FixedClock;
  let series: InMemoryPriceSeries;
  let audit: RecordingAuditWriter;
  let outbox: RecordingOutbox;
  const http = () => request(app.getHttpServer());

  async function boot() {
    audit = new RecordingAuditWriter();
    outbox = new RecordingOutbox();
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(PRICE_SERIES_REPOSITORY)
          .useValue(series)
          .overrideProvider(AUDIT_WRITER)
          .useValue(audit)
          .overrideProvider(OUTBOX_WRITER)
          .useValue(outbox),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  /** A series with a price in force and one held record submitted by `submitter`. */
  function heldSeries(code: string, n: number, submitter: Id<'Account'> = SELLER_ACCOUNT) {
    const fixture = PRICING_FIXTURES.find((f) => f.code === code)!;
    const policy = fixture.policy;
    const amount = (minor: bigint) => {
      const checked = priceAmount(money(minor, policy.currency), policy);
      if (!checked.ok) throw new Error('amount');
      return checked.value;
    };
    const offerId = id<'Offer'>(0x1000 + n);
    const variantId = id<'Variant'>(0x2000 + n);
    const aggregate = PriceSeries.create({
      id: id<'PriceSeries'>(0x3000 + n),
      marketId: marketOf(code).marketId,
      offerId,
      variantId,
      productId: id<'Product'>(0x4000 + n),
      sellerId: SELLER,
      currency: policy.currency,
      now: START.subtract({ hours: 1 }),
    });
    const set = (minor: bigint, recordN: number, at: Temporal.Instant) =>
      aggregate.setRegularPrice({
        recordId: id<'RegularPriceRecord'>(0x5000 + recordN),
        amount: amount(minor),
        submittedBy: submitter,
        taxInclusive: fixture.taxInclusive,
        now: at,
        policy,
      });
    set(fixture.base, n * 2, START.subtract({ hours: 1 }));
    const held = set(fixture.base * 4n, n * 2 + 1, START.subtract({ minutes: n }));
    if (!held.ok || held.value.kind !== 'held') throw new Error('no hold');
    series.rows.set(`${code}|${offerId}|${variantId}`, aggregate.state);
    return { recordId: held.value.record.id, offerId, variantId };
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'hold-0001'), {});
    const marketId = code as AccountState['marketId'];
    const role = (roleId: Id<'Role'>, name: string, permissionKeys: string[]) =>
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name,
        permissionKeys,
        version: 1,
        createdAt: START,
      });
    role(DECIDER_ROLE, 'Price reviewer', ['pricing.price-hold.decide', 'pricing.price-hold.view']);
    role(NO_KEY_ROLE, 'No pricing key', ['identity.admin-account.view']);
    const viewerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === 'viewer',
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
    admin(DECIDER, 'decider', DECIDER_ROLE);
    admin(VIEWER, 'viewer', viewerRole);
    admin(NO_KEY, 'nokey', NO_KEY_ROLE);
    // The submitter is also an admin account here, to prove the decider is never the submitter.
    admin(SELLER_ACCOUNT, 'submitter', DECIDER_ROLE);
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
  const get = (code: string, path: string, session: Record<string, string> | null) =>
    http()
      .get(`/pricing/admin/price-holds${path}`)
      .set({ ...base(code), ...(session === null ? {} : { cookie: session.cookie! }) });
  const post = (code: string, path: string, session: Record<string, string>, payload?: unknown) =>
    http()
      .post(`/pricing/admin/price-holds${path}`)
      .set({ ...base(code), ...session })
      .send(payload ?? {});

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    series = new InMemoryPriceSeries();
  });
  afterEach(async () => {
    await app.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the queue for a holder of the view key (the seeded Viewer), oldest first, no-store', async () => {
      await boot();
      await seeded(code);
      const older = heldSeries(code, 9);
      const newer = heldSeries(code, 1);

      const response = await get(code, '', sessionOf(code, VIEWER, 1));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as { items: Record<string, unknown>[]; next: unknown };
      expect(body.items.map((i) => i.recordId)).toEqual([older.recordId, newer.recordId]);
      expect(body.next).toBeNull();
      const fixture = PRICING_FIXTURES.find((f) => f.code === code)!;
      expect(body.items[0]).toMatchObject({
        kind: 'regular',
        direction: 'up',
        sellerId: SELLER,
        amount: { amount: (fixture.base * 4n).toString(), currency: fixture.policy.currency },
        anchorAmount: { amount: fixture.base.toString(), currency: fixture.policy.currency },
      });
      expect(Object.keys(body.items[0]!)).not.toContain('submittedBy');
      expect(JSON.stringify(body)).not.toContain(SELLER_ACCOUNT);
    });

    it('pages with limit and cursor, and refuses a bad cursor and a bad limit', async () => {
      await boot();
      await seeded(code);
      heldSeries(code, 3);
      heldSeries(code, 2);
      const session = sessionOf(code, VIEWER, 1);

      const first = await get(code, '?limit=1', session);
      const cursor = (first.body as { next: string }).next;
      expect(cursor).toEqual(expect.any(String));
      const second = await get(code, `?limit=1&after=${cursor}`, session);
      expect((second.body as { items: unknown[]; next: unknown }).items).toHaveLength(1);
      expect((second.body as { next: unknown }).next).toBeNull();
      expect((await get(code, '?after=nope', session)).status).toBe(400);
      expect((await get(code, '?limit=0', session)).status).toBe(400);
      expect((await get(code, '?limit=abc', session)).status).toBe(400);
    });

    it('answers 401 without a session and 403 without the key, for the reads', async () => {
      await boot();
      await seeded(code);
      const held = heldSeries(code, 1);

      expect((await get(code, '', null)).status).toBe(401);
      expect((await get(code, '', sessionOf(code, NO_KEY, 3))).status).toBe(403);
      expect((await get(code, `/${held.recordId}`, sessionOf(code, NO_KEY, 4))).status).toBe(403);
    });

    it('views one held record, and answers an unknown, a malformed and a foreign id alike', async () => {
      await boot();
      await seeded(code);
      const held = heldSeries(code, 1);
      const foreignCode = code === 'AU' ? 'ZZ' : 'AU';
      const foreign = heldSeries(foreignCode, 2);
      const session = sessionOf(code, VIEWER, 1);

      const one = await get(code, `/${held.recordId}`, session);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ recordId: held.recordId, offerId: held.offerId });
      const unknown = await get(code, `/${id<'RegularPriceRecord'>(0x9999)}`, session);
      const other = await get(code, `/${foreign.recordId}`, session);
      expect(unknown.status).toBe(404);
      expect(other.status).toBe(404);
      expect(other.body).toEqual(unknown.body);
      expect((await get(code, '/not-an-id', session)).status).toBe(400);
    });

    it('approves with the decide key: effective now, audited, no-store, logged', async () => {
      await boot();
      await seeded(code);
      const held = heldSeries(code, 1);

      const response = await post(code, `/${held.recordId}/approve`, sessionOf(code, DECIDER, 1));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toMatchObject({
        recordId: held.recordId,
        outcome: 'approved',
        effectiveFrom: START.toString(),
        seriesVersion: expect.any(Number) as unknown,
      });
      expect(audit.rows.map((r) => r.action)).toEqual(['pricing.price-hold.approved']);
      expect(audit.rows[0]).toMatchObject({ actorKind: 'authenticated', market: code });
      expect(outbox.events.map((e) => e.type)).toEqual([
        'pricing.price-hold-decided.v1',
        'pricing.effective-price-changed.v1',
      ]);
      expect(
        logLines.find((l) => l.msg === 'pricing.approve-price-hold' && l.outcome),
      ).toMatchObject({ outcome: 'approved', marketId: code });
      // Decided: the queue is empty and a second approval is not pending.
      const queue = await get(code, '', sessionOf(code, VIEWER, 2));
      expect((queue.body as { items: unknown[] }).items).toEqual([]);
      const again = await post(code, `/${held.recordId}/approve`, sessionOf(code, DECIDER, 3));
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ statusCode: 409, code: 'pricing.hold.not-pending' });
    });

    it('refuses to decide without the protected decide key, even with the view key (403)', async () => {
      await boot();
      await seeded(code);
      const held = heldSeries(code, 1);

      for (const [account, n] of [
        [VIEWER, 1],
        [NO_KEY, 2],
      ] as const) {
        const approve = await post(code, `/${held.recordId}/approve`, sessionOf(code, account, n));
        const reject = await post(
          code,
          `/${held.recordId}/reject`,
          sessionOf(code, account, n + 10),
          {
            reasonCode: 'other',
          },
        );
        expect([approve.status, reject.status]).toEqual([403, 403]);
        expect(approve.body).toEqual({ statusCode: 403, code: 'access.denied' });
      }
      expect(audit.rows).toEqual([]);
    });

    it('refuses the account that submitted the record, for both decisions (H4)', async () => {
      await boot();
      await seeded(code);
      const held = heldSeries(code, 1, SELLER_ACCOUNT);
      const session = sessionOf(code, SELLER_ACCOUNT, 1);

      const approve = await post(code, `/${held.recordId}/approve`, session);
      const reject = await post(code, `/${held.recordId}/reject`, session, { reasonCode: 'other' });

      expect(approve.status).toBe(403);
      expect(approve.body).toEqual({ statusCode: 403, code: 'pricing.hold.own-submission' });
      expect(reject.status).toBe(403);
      expect(audit.rows).toEqual([]);
      expect(outbox.events).toEqual([]);
    });

    it('rejects with a reason and refuses a missing or unknown reason, an unknown field and a long note', async () => {
      await boot();
      await seeded(code);
      const held = heldSeries(code, 1);
      const session = sessionOf(code, DECIDER, 1);

      const noReason = await post(code, `/${held.recordId}/reject`, session, {});
      expect(noReason.status).toBe(400);
      expect(noReason.body).toMatchObject({
        details: { fields: [{ path: 'reasonCode', code: 'required' }] },
      });
      const unknownReason = await post(code, `/${held.recordId}/reject`, session, {
        reasonCode: 'because',
      });
      expect(unknownReason.body).toMatchObject({
        details: { fields: [{ path: 'reasonCode', code: 'enum' }] },
      });
      const extra = await post(code, `/${held.recordId}/reject`, session, {
        reasonCode: 'other',
        status: 'approved',
      });
      expect(extra.body).toMatchObject({
        details: { fields: [{ path: 'status', code: 'unknown-field' }] },
      });
      const long = await post(code, `/${held.recordId}/reject`, session, {
        reasonCode: 'other',
        note: 'x'.repeat(1001),
      });
      expect(long.body).toMatchObject({ details: { fields: [{ path: 'note', code: 'length' }] } });
      expect(audit.rows).toEqual([]);

      const rejected = await post(code, `/${held.recordId}/reject`, session, {
        reasonCode: 'price-implausible',
        note: 'please check the unit',
      });
      expect(rejected.status).toBe(200);
      expect(rejected.body).toMatchObject({ recordId: held.recordId, outcome: 'rejected' });
      expect(audit.rows.map((r) => r.action)).toEqual(['pricing.price-hold.rejected']);
      expect(
        JSON.stringify(audit.rows, (_k, v: unknown) => (typeof v === 'bigint' ? '0' : v)),
      ).not.toContain('check the unit');
      expect(JSON.stringify(logLines)).not.toContain('check the unit');
    });

    it('answers a foreign Market’s record as an unknown id, and a record that is no longer pending as 409', async () => {
      await boot();
      await seeded(code);
      const foreignCode = code === 'AU' ? 'ZZ' : 'AU';
      const foreign = heldSeries(foreignCode, 2);
      const mine = heldSeries(code, 1);
      const session = sessionOf(code, DECIDER, 1);

      const approveForeign = await post(code, `/${foreign.recordId}/approve`, session);
      const approveUnknown = await post(
        code,
        `/${id<'RegularPriceRecord'>(0x9999)}/approve`,
        session,
      );
      expect(approveForeign.status).toBe(404);
      expect(approveForeign.body).toEqual(approveUnknown.body);
      const rejectForeign = await post(code, `/${foreign.recordId}/reject`, session, {
        reasonCode: 'other',
      });
      expect(rejectForeign.status).toBe(404);

      await post(code, `/${mine.recordId}/reject`, session, { reasonCode: 'other' });
      const stale = await post(code, `/${mine.recordId}/reject`, session, { reasonCode: 'other' });
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ statusCode: 409, code: 'pricing.hold.not-pending' });
      const bad = await post(code, '/not-an-id/approve', session);
      expect(bad.status).toBe(400);
    });

    it('needs the CSRF token and the panel origin on the decisions', async () => {
      await boot();
      await seeded(code);
      const held = heldSeries(code, 1);
      const session = sessionOf(code, DECIDER, 1);

      const noCsrf = await http()
        .post(`/pricing/admin/price-holds/${held.recordId}/approve`)
        .set({ ...base(code), cookie: session.cookie })
        .send({});
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      const noSession = await http()
        .post(`/pricing/admin/price-holds/${held.recordId}/approve`)
        .set(base(code))
        .send({});
      expect(noSession.status).toBe(401);
      const noOrigin = await http()
        .post(`/pricing/admin/price-holds/${held.recordId}/approve`)
        .set({ 'x-market-id': code, ...session })
        .send({});
      expect([401, 403]).toContain(noOrigin.status);
      expect(audit.rows).toEqual([]);
    });
  });
});
