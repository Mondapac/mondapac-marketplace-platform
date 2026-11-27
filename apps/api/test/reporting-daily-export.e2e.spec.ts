import type { NestExpressApplication } from '@nestjs/platform-express';
import { encodeAuditFields, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import {
  ADMIN_KPI_READER,
  type AdminKpiReader,
} from '../src/modules/reporting/application/ports/admin-kpi-reader';
import {
  SELLER_KPI_READER,
  type SellerKpiReader,
} from '../src/modules/reporting/application/ports/seller-kpi-reader';
import { emptyDay } from '../src/modules/reporting/domain/admin-kpi';
import { REPORTING_AUDIT_ACTIONS } from '../src/modules/reporting/domain/audit';
import type { DayRange } from '../src/modules/reporting/domain/period';
import { AUDIT_WRITER, type AuditWriter } from '../src/platform/audit/audit-writer';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The daily exports over HTTP (dashboards v2, PR 5), on both Market fixtures, with the real guards,
// gate and use cases over fake readers: the keys each needs (the view keys and the export key),
// the seller only ever the session's (a `sellerId` in the query is refused, never read), the
// 13-month cap and "not after today" as 400 with the field, the file (UTF-8 byte order mark,
// header, one row per Market day, money in minor units with the currency) and one audit row per
// download that names the range and the count but no figure.

const START = Temporal.Instant.from('2026-11-24T01:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const CURRENCY: Record<string, string> = { AU: 'AUD', ZZ: 'JPY' };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const ADMIN_NO_EXPORT = id<'Account'>(0xa002);
const OWNER = id<'Account'>(0xa101);
const CLERK = id<'Account'>(0xa102);
const SELLER = id<'Seller'>(0x5e11);
const OTHER_SELLER = id<'Seller'>(0x5e12);
const NO_EXPORT_ROLE = id<'Role'>(0xc001);
const CLERK_ROLE = id<'Role'>(0xc002);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

/** Collects audit rows, each checked against reporting's catalogue definition (W4). */
class RecordingAudit implements AuditWriter {
  readonly rows: (AuditEntry & { readonly market: string })[] = [];
  record(context: CallContext, entry: AuditEntry): Promise<void> {
    const definition = REPORTING_AUDIT_ACTIONS.find((d) => d.action === entry.action);
    if (definition === undefined) throw new Error(`audit: unknown action ${entry.action}`);
    if (definition.targetType !== entry.targetType) throw new Error('audit: target type');
    const checked = encodeAuditFields(definition.after, entry.after, {
      isKnownPermissionKey: () => false,
    });
    if (!checked.ok) throw new Error(`audit: ${JSON.stringify(checked.error)}`);
    this.rows.push({ ...entry, market: context.market.marketId });
    return Promise.resolve();
  }
}

describe.each(TEST_MARKETS)('the daily exports over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let audit: RecordingAudit;
  let adminReads: { currency: string; range: DayRange }[];
  let sellerReads: { sellerId: string; currency: string; range: DayRange }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const market: MarketContext = testMarketContext(code, PLATFORM_TENANT_ID);

  const adminReader: Pick<AdminKpiReader, 'dailyTotals'> = {
    dailyTotals: (_m, currency, range) => {
      adminReads.push({ currency, range });
      return Promise.resolve({
        days: [
          {
            ...emptyDay(range.from),
            ordersPaid: 2,
            goodsAmount: 2200n,
            goodsTax: 200n,
            refunds: 1,
            refundGoodsAmount: -1100n,
            refundGoodsTax: -100n,
          },
        ],
        refreshedAt: START,
      });
    },
  };
  const sellerReader: Pick<SellerKpiReader, 'daily'> = {
    daily: (_m, sellerId, currency, range) => {
      sellerReads.push({ sellerId, currency, range });
      return Promise.resolve([]);
    },
  };

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(AUDIT_WRITER)
          .useValue(audit)
          .overrideProvider(ADMIN_KPI_READER)
          .useValue(adminReader)
          .overrideProvider(SELLER_KPI_READER)
          .useValue(sellerReader),
    }));
    await app.get(SeedRoles).execute(testCallContext(market, 'system', 'export-0001'), {});
    const seeded = (scope: 'platform' | 'seller', seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === scope && r.seedCode === seedCode,
      )!.id;
    fakes.seedRole({
      id: NO_EXPORT_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Finance without export',
      permissionKeys: ['commission-payouts.settlement.view', 'ordering.order.view'],
      version: 1,
      createdAt: START,
    });
    fakes.seedRole({
      id: CLERK_ROLE,
      marketId,
      scope: 'seller',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: SELLER,
      name: 'Orders only',
      permissionKeys: ['ordering.seller-order.view'],
      version: 1,
      createdAt: START,
    });
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 3,
      createdAt: START,
    });
    const accounts = [
      [ADMIN, 'admin', 'admin', seeded('platform', 'platform-administrator'), 1],
      [ADMIN_NO_EXPORT, 'admin', 'finance', NO_EXPORT_ROLE, 2],
      [OWNER, 'seller', 'owner', seeded('seller', 'seller-owner'), 3],
      [CLERK, 'seller', 'clerk', CLERK_ROLE, 4],
    ] as const;
    for (const [accountId, population, label, roleId, n] of accounts) {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: label,
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
      if (population === 'seller') {
        fakes.seedMembership({
          id: id<'SellerMembership'>(0xeb00 + n),
          marketId,
          accountId,
          sellerId: SELLER,
          state: 'active',
          removedAt: null,
          version: 1,
          createdAt: START,
        });
      }
    }
  }

  function sessionOf(accountId: Id<'Account'>, population: 'seller' | 'admin', n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      market,
      openSession({
        id: id<'Session'>(0xf200 + n),
        marketId,
        accountId,
        population,
        sellerId: population === 'seller' ? SELLER : null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
      }),
      issued.tokenHash,
    );
    return { cookie: `__Host-session-${population}-${code}=${issued.token}` };
  }

  const adminGet = (headers: Record<string, string>, query: Record<string, string>) =>
    http()
      .get('/reporting/admin/daily/export')
      .query(query)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers });
  const sellerGet = (headers: Record<string, string>, query: Record<string, string>) =>
    http()
      .get('/reporting/seller/daily/export')
      .query(query)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers });

  beforeEach(() => {
    fakes.reset();
    audit = new RecordingAudit();
    adminReads = [];
    sellerReads = [];
  });
  afterEach(async () => {
    await app?.close();
  });

  it('sends the marketplace days of a custom range as a CSV and audits the download', async () => {
    await boot();
    const reply = await adminGet(sessionOf(ADMIN, 'admin', 1), {
      from: '2026-10-30',
      to: '2026-11-01',
    });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['content-disposition']).toBe(
      'attachment; filename="marketplace-daily-2026-10-30-2026-11-01.csv"',
    );
    const lines = reply.text.split('\r\n');
    expect(lines[0]!.startsWith('﻿Day,Currency,GMV incl. tax (minor units)')).toBe(true);
    const currency = CURRENCY[code]!;
    expect(lines.slice(1, 5)).toEqual([
      `2026-10-30,${currency},2200,2000,1100,1100,2,0,0,0,0,1`,
      `2026-10-31,${currency},0,0,0,0,0,0,0,0,0,0`,
      `2026-11-01,${currency},0,0,0,0,0,0,0,0,0,0`,
      '',
    ]);
    expect(adminReads).toEqual([{ currency, range: { from: '2026-10-30', to: '2026-11-01' } }]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'reporting.marketplace-daily.exported',
      targetId: 'marketplace-daily',
      market: code,
      after: { period: 'custom', days: 3, format: 'csv', rowCount: 3 },
    });
    // The range in the Market's zone: midnight of its first day to midnight after its last.
    const zone = code === 'AU' ? 'Australia/Brisbane' : 'Asia/Tokyo';
    const after = audit.rows[0]!.after as {
      rangeStart: Temporal.Instant;
      rangeEnd: Temporal.Instant;
    };
    expect(after.rangeStart.toString()).toBe(
      Temporal.PlainDate.from('2026-10-30').toZonedDateTime(zone).toInstant().toString(),
    );
    expect(after.rangeEnd.toString()).toBe(
      Temporal.PlainDate.from('2026-11-02').toZonedDateTime(zone).toInstant().toString(),
    );
    // Only the exported content is checked: ids and timestamps of the row can hold "2200" by chance.
    expect(JSON.stringify(audit.rows[0]!.after)).not.toContain('2200');
  });

  it('refuses an admin without the export key, before any read or audit', async () => {
    await boot();
    const reply = await adminGet(sessionOf(ADMIN_NO_EXPORT, 'admin', 2), { period: '7d' });
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({ statusCode: 403, code: 'access.denied' });
    expect(adminReads).toEqual([]);
    expect(audit.rows).toEqual([]);
  });

  it.each([
    [{ from: '2025-10-24', to: '2026-11-24' }, [{ path: 'from', code: 'too-long' }]],
    [{ from: '2026-11-20', to: '2026-11-25' }, [{ path: 'to', code: 'future' }]],
    [{ from: '2026-11-02', to: '2026-11-01' }, [{ path: 'from', code: 'after-to' }]],
    [{ period: 'year' }, [{ path: 'period', code: 'enum' }]],
    [{ format: 'pdf' }, [{ path: 'format', code: 'value' }]],
  ])('answers 400 for %j and reads nothing', async (query, fields) => {
    await boot();
    const reply = await adminGet(sessionOf(ADMIN, 'admin', 1), query);
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ statusCode: 400, code: 'validation.failed', details: { fields } });
    expect(adminReads).toEqual([]);
    expect(audit.rows).toEqual([]);
  });

  it('accepts the longest range, 13 months to today', async () => {
    await boot();
    const reply = await adminGet(sessionOf(ADMIN, 'admin', 1), {
      from: '2025-10-25',
      to: '2026-11-24',
    });
    expect(reply.status).toBe(200);
    expect(audit.rows[0]).toMatchObject({ after: { days: 396, rowCount: 396 } });
  });

  it("sends the session seller's own days and audits them on that seller", async () => {
    await boot();
    const reply = await sellerGet(sessionOf(OWNER, 'seller', 3), {
      period: 'today',
      format: 'csv',
    });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-disposition']).toBe(
      'attachment; filename="sales-daily-2026-11-24-2026-11-24.csv"',
    );
    expect(reply.text.split('\r\n')[1]).toBe(`2026-11-24,${CURRENCY[code]!},0,0,0,0,0,0,0,0,0`);
    expect(sellerReads).toEqual([
      {
        sellerId: SELLER,
        currency: CURRENCY[code],
        range: { from: '2026-11-24', to: '2026-11-24' },
      },
    ]);
    expect(audit.rows).toMatchObject([
      {
        action: 'reporting.seller-daily.exported',
        targetId: SELLER,
        after: { period: 'today', days: 1, rowCount: 1 },
      },
    ]);
  });

  it('never exports another seller: a sellerId in the query is refused unread', async () => {
    await boot();
    const reply = await sellerGet(sessionOf(OWNER, 'seller', 3), {
      period: '7d',
      sellerId: OTHER_SELLER,
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'sellerId', code: 'unknown-field' }] },
    });
    expect(sellerReads).toEqual([]);
    expect(audit.rows).toEqual([]);
  });

  it('refuses a seller team member without the export key', async () => {
    await boot();
    const reply = await sellerGet(sessionOf(CLERK, 'seller', 4), { period: '7d' });
    expect(reply.status).toBe(403);
    expect(sellerReads).toEqual([]);
  });

  it('refuses a range over 13 months on the seller export too', async () => {
    await boot();
    const reply = await sellerGet(sessionOf(OWNER, 'seller', 3), {
      from: '2025-10-01',
      to: '2026-11-24',
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ details: { fields: [{ path: 'from', code: 'too-long' }] } });
  });

  it('reads no admin session from a seller cookie, nor a seller session from an admin cookie', async () => {
    await boot();
    expect((await adminGet(sessionOf(OWNER, 'seller', 3), {})).status).toBe(401);
    expect((await sellerGet(sessionOf(ADMIN, 'admin', 1), {})).status).toBe(401);
    expect(adminReads).toEqual([]);
    expect(sellerReads).toEqual([]);
  });
});
