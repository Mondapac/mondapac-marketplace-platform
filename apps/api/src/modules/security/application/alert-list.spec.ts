import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { ExceljsSheetWriter, type ExportFile } from '../../../platform/list-export';
import type { PermissionProbe } from '../../../platform/list-query';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { SECURITY_RESPOND } from '../contracts/permissions';
import type { SecurityAlert } from '../domain/alert';
import type { AlertKeyType } from '../domain/rules';
import type { AlertListDependencies } from './alert-list-flow';
import {
  InMemorySecurityAlerts,
  StaticAdminNames,
  StaticRoster,
  testRoster,
} from './testing/in-memory-security';
import { ExportSecurityAlerts } from './use-cases/export-security-alerts.use-case';
import { QuerySecurityAlerts } from './use-cases/query-security-alerts.use-case';

// The security centre's alert super list (list 37) and its export in memory on both Market
// fixtures: views and counts, filters, sort, both paging modes, row actions by key, state and the
// s1 resolver rule, masked addresses and the export. The Prisma twin of the filters and sorts is in
// test/db/security-alert-list.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-01T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALI = id<'Account'>(0xa1);
const HASSAN = id<'Account'>(0xa2);
const RESPONDER = id<'Account'>(0xa4);

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}

const held: PermissionProbe = { execute: () => Promise.resolve({ ok: true }) };
const denied: PermissionProbe = { execute: () => Promise.resolve({ ok: false }) };

describe.each([['AU'], ['ZZ']] as const)('security alert list in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  let alerts: InMemorySecurityAlerts;
  let deps: AlertListDependencies;
  const gate = createUseCaseGate(markets, {
    check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
  });

  const adminCtx = (accountId: Id<'Account'> = RESPONDER): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'alert-list-abcd',
    );
  const sellerCtx = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: id<'Account'>(0xa9),
        sessionId: id<'Session'>(0x62),
        sellerId: id<'Seller'>(0x5e1),
      }),
      'alert-list-seller',
    );

  let n = 0;
  const addAlert = (
    extra: Partial<SecurityAlert> & { market?: string } = {},
    keyType: AlertKeyType = 'account',
  ): SecurityAlert => {
    n += 1;
    const { market: marketId = market.marketId, ...fields } = extra;
    const alert: SecurityAlert = {
      id: id<'SecurityAlert'>(0x7000 + n),
      rule: 'sign-in-failures-account',
      severity: 's2',
      state: 'open',
      keyType,
      keyValue: `key-${n}`,
      eventCount: 10 + n,
      firstEventAt: T0.add({ seconds: n }),
      lastEventAt: T0.add({ seconds: n + 60 }),
      openedAt: T0.add({ seconds: n + 60 }),
      notifyStep: 0,
      nextNotifyAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      resolutionNote: null,
      version: 1,
      ...fields,
    };
    alerts.alerts.push({ ...alert, market: marketId });
    return alert;
  };

  const query = (input: Record<string, unknown> = {}, ctx = adminCtx()) =>
    new QuerySecurityAlerts(gate, deps).execute(ctx, input);
  const exporter = (input: Record<string, unknown> = {}, ctx = adminCtx()) =>
    new ExportSecurityAlerts(gate, deps).execute(ctx, input);
  const ok = async (input: Record<string, unknown> = {}) => {
    const result = await query(input);
    if (!result.ok) throw new Error(`refused: ${result.error.code}`);
    return result.value;
  };
  const ids = (page: { items: readonly { id: string }[] }) => page.items.map((row) => row.id);

  beforeEach(() => {
    n = 0;
    alerts = new InMemorySecurityAlerts();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      alerts,
      roster: new StaticRoster(testRoster({ ali: ALI, hassan: HASSAN })),
      names: new StaticAdminNames({ [HASSAN]: 'Hassan R.' }),
      probes: { [SECURITY_RESPOND.key]: held },
      sheetWriter: new ExceljsSheetWriter(),
      clock: new FixedClock(T0.add({ hours: 1 })),
    };
  });

  it('refuses a caller that is not an admin session', async () => {
    const result = await query({}, sellerCtx());
    expect(result.ok ? null : result.error.code).toBe('access.denied');
  });

  it('lists the alerts of its Market only, s1 first then newest, with the view counts', async () => {
    const a = addAlert({ severity: 's3' });
    const b = addAlert({ severity: 's1' });
    const c = addAlert({ severity: 's3' });
    addAlert({ market: other.marketId });
    const page = await ok();
    expect(ids(page)).toEqual([b.id, c.id, a.id]);
    expect(page.total).toBe(3);
    expect(page.counts).toEqual({ all: 3, open: 3, acknowledged: 0, critical: 1, resolved: 0 });
  });

  it('filters by view, severity, rule, key, events and opened range', async () => {
    const a = addAlert({ severity: 's1', rule: 'admin-sign-in-after-failures' });
    const b = addAlert({ state: 'acknowledged', severity: 's2', eventCount: 50 });
    const c = addAlert({ state: 'resolved', severity: 's1' });
    const d = addAlert({ severity: 's3' }, 'ip');
    expect(ids(await ok({ view: 'critical' }))).toEqual([a.id]);
    expect(ids(await ok({ view: 'acknowledged' }))).toEqual([b.id]);
    expect(ids(await ok({ view: 'resolved' }))).toEqual([c.id]);
    expect(new Set(ids(await ok({ severity: 's1,s3' })))).toEqual(new Set([a.id, c.id, d.id]));
    expect(ids(await ok({ rule: 'admin-sign-in-after-failures' }))).toEqual([a.id]);
    expect(ids(await ok({ keyType: 'ip' }))).toEqual([d.id]);
    expect(ids(await ok({ keyValue: d.keyValue }))).toEqual([d.id]);
    expect(ids(await ok({ minEvents: '50' }))).toEqual([b.id]);
    expect(ids(await ok({ from: d.openedAt.toString() }))).toEqual([d.id]);
    expect(ids(await ok({ to: b.openedAt.toString() }))).toEqual([a.id]);
  });

  it('keeps the view counts whatever the filter, and combines the critical view with severity', async () => {
    const a = addAlert({ severity: 's1' });
    addAlert({ severity: 's2' });
    addAlert({ severity: 's1', state: 'resolved' });
    const all = (await ok()).counts;
    expect(all).toEqual({ all: 3, open: 2, acknowledged: 0, critical: 1, resolved: 1 });
    expect((await ok({ view: 'resolved' })).counts).toEqual(all);
    expect(ids(await ok({ view: 'critical', severity: 's1' }))).toEqual([a.id]);
    expect(ids(await ok({ view: 'critical', severity: 's1,s2' }))).toEqual([a.id]);
    const none = await ok({ view: 'critical', severity: 's2' });
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('stops at 10,000 rows: no Next on the last window and no page past it', async () => {
    for (let i = 0; i < 10_001; i += 1) addAlert();
    const last = await ok({ paging: 'prev-next', page: 400, pageSize: 25 });
    expect(last.items).toHaveLength(25);
    expect(last.hasNext).toBe(false);
    expect((await ok({ paging: 'prev-next', page: 399, pageSize: 25 })).hasNext).toBe(true);
    for (const input of [
      { page: 401, pageSize: 25 },
      { page: 101, pageSize: 100 },
    ]) {
      expect((await query(input)).ok).toBe(false);
    }
  });

  it('masks an address key in the rows', async () => {
    addAlert({ keyValue: '203.0.113.7', rule: 'sign-in-failures-ip' }, 'ip');
    const page = await ok();
    expect(page.items[0]!.keyLabel).toBe('203.0.113.…');
    expect(JSON.stringify(page)).not.toContain('203.0.113.7');
  });

  it('sorts and breaks ties by the id, in both directions', async () => {
    const a = addAlert({ eventCount: 5 });
    const b = addAlert({ eventCount: 5 });
    const c = addAlert({ eventCount: 9 });
    expect(ids(await ok({ sort: 'events', direction: 'asc' }))).toEqual([a.id, b.id, c.id]);
    expect(ids(await ok({ sort: 'events', direction: 'desc' }))).toEqual([c.id, b.id, a.id]);
    expect(ids(await ok({ sort: 'opened', direction: 'asc' }))).toEqual([a.id, b.id, c.id]);
  });

  it('pages with page numbers and a total, or Previous/Next without one', async () => {
    for (let i = 0; i < 5; i += 1) addAlert();
    const second = await ok({ page: 2, pageSize: 2, sort: 'opened', direction: 'asc' });
    expect(second.items).toHaveLength(2);
    expect(second.total).toBe(5);
    const nextOnly = await ok({ paging: 'prev-next', page: 3, pageSize: 2 });
    expect(nextOnly.total).toBeNull();
    expect(nextOnly.items).toHaveLength(1);
    expect(nextOnly.hasNext).toBe(false);
    expect((await ok({ paging: 'prev-next', pageSize: 2 })).hasNext).toBe(true);
  });

  it('refuses unknown keys and bad values', async () => {
    for (const input of [
      { x: '1' },
      { view: 'other' },
      { severity: 's9' },
      { severity: 's1,' },
      { rule: 'nope' },
      { keyType: 'user' },
      { keyValue: 'a\nb' },
      { keyValue: 'a‮b' },
      { keyValue: 'a'.repeat(65) },
      { minEvents: '0' },
      { minEvents: 'x' },
      { sort: 'rule' },
      { page: 101, pageSize: 100 },
    ]) {
      const result = await query(input);
      expect(result.ok).toBe(false);
    }
  });

  describe('row actions', () => {
    const actionsOf = async (alert: SecurityAlert, as = adminCtx()) =>
      (
        await (async () => {
          const result = await query({}, as);
          if (!result.ok) throw new Error('refused');
          return result.value;
        })()
      ).items.find((row) => row.id === alert.id)!.actions;

    it('offers what the state allows', async () => {
      const open = addAlert();
      expect(await actionsOf(open)).toEqual(['open', 'acknowledge', 'resolve']);
      const acknowledged = addAlert({ state: 'acknowledged' });
      expect(await actionsOf(acknowledged)).toEqual(['open', 'resolve']);
      const resolved = addAlert({ state: 'resolved' });
      expect(await actionsOf(resolved)).toEqual(['open']);
    });

    it('offers resolving an s1 alert only to the roster’s resolvers', async () => {
      const critical = addAlert({ severity: 's1' });
      expect(await actionsOf(critical, adminCtx(RESPONDER))).toEqual(['open', 'acknowledge']);
      expect(await actionsOf(critical, adminCtx(ALI))).toEqual(['open', 'acknowledge', 'resolve']);
    });

    it('offers an acknowledged s1 alert’s Resolve only to the roster’s resolvers', async () => {
      const critical = addAlert({ severity: 's1', state: 'acknowledged' });
      expect(await actionsOf(critical, adminCtx(RESPONDER))).toEqual(['open']);
      expect(await actionsOf(critical, adminCtx(HASSAN))).toEqual(['open', 'resolve']);
    });

    it('offers only Open without the respond key', async () => {
      const open = addAlert();
      deps = { ...deps, probes: { [SECURITY_RESPOND.key]: denied } };
      expect(await actionsOf(open)).toEqual(['open']);
    });
  });

  describe('export', () => {
    it('writes a CSV of the list with the optional columns and no note', async () => {
      const a = addAlert(
        {
          state: 'resolved',
          resolution: 'contained',
          resolutionNote: 'SECRET NOTE',
          resolvedAt: T0,
          resolvedBy: HASSAN,
          keyValue: '203.0.113.7',
          rule: 'sign-in-failures-ip',
        },
        'ip',
      );
      addAlert({ severity: 's1' });
      const result = await exporter({ columns: 'alert-id,resolution', view: 'resolved' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.filename).toMatch(/^security-alerts-\d{4}-\d{2}-\d{2}\.csv$/);
      const csv = await text(result.value);
      const lines = csv.trim().split(/\r?\n/);
      expect(lines[0]).toBe(
        'Alert,Severity,State,Key type,Key,Events,Opened (UTC),Alert ID,Resolution',
      );
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(a.id);
      expect(lines[1]).toContain('203.0.113.…');
      expect(csv).not.toContain('203.0.113.7');
      expect(csv).not.toContain('SECRET NOTE');
    });

    it('writes the chosen ids and refuses one outside the Market, or too many', async () => {
      const mine = addAlert();
      const foreign = addAlert({ market: other.marketId });
      expect((await exporter({ ids: mine.id })).ok).toBe(true);
      const refused = await exporter({ ids: `${mine.id},${foreign.id}` });
      expect(refused.ok ? null : refused.error.code).toBe('security.alert-not-found');
      const many = Array.from({ length: 201 }, (_, i) => id<'SecurityAlert'>(0x8000 + i)).join(',');
      const tooMany = await exporter({ ids: many });
      expect(tooMany.ok ? null : tooMany.error).toMatchObject({
        code: 'batch.too-large',
        max: 200,
      });
      expect((await exporter({ ids: '' })).ok).toBe(false);
      expect((await exporter({ ids: `${mine.id},${mine.id}` })).ok).toBe(false);
    });

    it('writes an XLSX, a header-only file when empty, and refuses bad input', async () => {
      const empty = await exporter({});
      expect(empty.ok).toBe(true);
      if (empty.ok) expect((await text(empty.value)).trim().split(/\r?\n/)).toHaveLength(1);
      addAlert();
      const xlsx = await exporter({ format: 'xlsx' });
      expect(xlsx.ok && xlsx.value.filename.endsWith('.xlsx')).toBe(true);
      expect((await exporter({ format: 'pdf' })).ok).toBe(false);
      expect((await exporter({ page: 2 })).ok).toBe(false);
      const wrong = await exporter({}, sellerCtx());
      expect(wrong.ok ? null : wrong.error.code).toBe('access.denied');
    });
  });
});
