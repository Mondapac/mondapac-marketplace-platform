import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { passThroughUnitOfWork } from '../../../../../test/support/certification-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { ExceljsSheetWriter, type ExportFile } from '../../../../platform/list-export';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import type { IssuerRequestListDependencies } from '../issuer-requests/issuer-request-list-flow';
import type {
  IssuerRequestQueueEntry,
  IssuerRequestRepository,
} from '../ports/issuer-request.repository';
import { IssuerRequestsExport } from './issuer-requests-export.use-case';
import { IssuerRequestsQuery } from './issuer-requests-query.use-case';

// The open issuer-request super list (list 36) and its export in memory, on both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-10T10:00:00Z');

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}

describe.each(['AU', 'ZZ'] as const)('issuer-request list and export in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const foreign: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');

  function setup(options: { mayEdit?: boolean; namesFail?: boolean } = {}) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const byMarket = new Map<string, IssuerRequestQueueEntry[]>();
    const requests = {
      openQueue: (m: MarketContext, cap: number) =>
        Promise.resolve((byMarket.get(m.marketId) ?? []).slice(0, cap)),
    } as unknown as IssuerRequestRepository;
    const names = new Map<Id<'Seller'>, string>();
    const deps: IssuerRequestListDependencies = {
      unitOfWork: passThroughUnitOfWork,
      requests,
      sellers: {
        storeNames: () =>
          options.namesFail === true
            ? Promise.reject(new Error('sellers down'))
            : Promise.resolve(names),
        businessDetails: () => Promise.reject(new Error('not used')),
      },
      probes: {
        [CERTIFICATION_ISSUER_EDIT.key]: {
          execute: () => Promise.resolve({ ok: options.mayEdit ?? true }),
        },
      },
      sheetWriter: new ExceljsSheetWriter(),
      clock,
    };
    const list = new IssuerRequestsQuery(gate, deps);
    const exporter = new IssuerRequestsExport(gate, deps);
    const admin = (m: MarketContext = market): CallContext =>
      testCallContext(
        m,
        testAuthenticatedActor(m, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
    function open(typeCode: string, hoursAfter: number, m: MarketContext = market) {
      const entry: IssuerRequestQueueEntry = {
        id: ids.next<'IssuerRequest'>(),
        sellerId: ids.next<'Seller'>(),
        typeCode,
        version: 1,
        documentCount: 1,
        createdAt: T0.add({ hours: hoursAfter }),
      };
      byMarket.set(m.marketId, [...(byMarket.get(m.marketId) ?? []), entry]);
      return entry;
    }
    return { list, exporter, admin, open, names, ids };
  }

  it('lists oldest first with the count and the row actions, and names stores', async () => {
    const { list, admin, open, names } = setup();
    const late = open('halal', 5);
    const early = open('kosher', 1);
    names.set(early.sellerId, 'Early Store');
    const result = await list.execute(admin(), {});
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.items.map((r) => r.issuerRequestId)).toEqual([early.id, late.id]);
    expect(result.value.items[0]).toMatchObject({
      storeName: 'Early Store',
      actions: ['open', 'answer'],
    });
    expect(result.value.items[1]?.storeName).toBeNull();
    expect(result.value.counts).toEqual({ all: 2 });
    expect(result.value.truncated).toBe(false);
    expect(result.value.total).toBe(2);
  });

  it('offers only Open to a caller who may not edit, and still lists when names fail', async () => {
    const { list, admin, open } = setup({ mayEdit: false, namesFail: true });
    open('halal', 1);
    const result = await list.execute(admin(), {});
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.items[0]?.actions).toEqual(['open']);
    expect(result.value.items[0]?.storeName).toBeNull();
  });

  it('filters by type, seller, id and submission range', async () => {
    const { list, admin, open } = setup();
    const a = open('halal', 1);
    const b = open('kosher', 3);
    open('halal', 6);
    const ask = async (input: Record<string, unknown>) => {
      const result = await list.execute(admin(), input);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value.items.map((r) => r.issuerRequestId);
    };
    expect(await ask({ type: 'kosher' })).toEqual([b.id]);
    expect(await ask({ sellerId: a.sellerId })).toEqual([a.id]);
    expect(await ask({ q: a.id.toUpperCase() })).toEqual([a.id]);
    expect(
      await ask({ from: T0.add({ hours: 2 }).toString(), to: T0.add({ hours: 4 }).toString() }),
    ).toEqual([b.id]);
  });

  it('sorts by type and by submission, newest first on request, with ties broken by id', async () => {
    const { list, admin, open } = setup();
    const a = open('kosher', 1);
    const b = open('halal', 1);
    const c = open('halal', 2);
    const ask = async (input: Record<string, unknown>) => {
      const result = await list.execute(admin(), input);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value.items.map((r) => r.issuerRequestId);
    };
    expect(await ask({ sort: 'submitted', direction: 'desc' })).toEqual([c.id, b.id, a.id]);
    const byType = await ask({ sort: 'type', direction: 'asc' });
    expect(byType.slice(0, 2).sort()).toEqual([b.id, c.id].sort());
    expect(byType[2]).toBe(a.id);
  });

  it('pages with a total, or Previous/Next without one', async () => {
    const { list, admin, open } = setup();
    for (let i = 0; i < 5; i += 1) open('halal', i);
    const pages = await list.execute(admin(), { page: 2, pageSize: 2 });
    if (!pages.ok) throw new Error(JSON.stringify(pages.error));
    expect(pages.value).toMatchObject({ page: 2, total: 5, hasNext: true });
    expect(pages.value.items).toHaveLength(2);
    const prevNext = await list.execute(admin(), { page: 3, pageSize: 2, paging: 'prev-next' });
    if (!prevNext.ok) throw new Error(JSON.stringify(prevNext.error));
    expect(prevNext.value).toMatchObject({ total: null, hasNext: false });
    expect(prevNext.value.items).toHaveLength(1);
    // Past the end is an empty page; a page beyond 10,000 rows, a bad size or mode is refused.
    const past = await list.execute(admin(), { page: 9, pageSize: 2 });
    if (!past.ok) throw new Error(JSON.stringify(past.error));
    expect(past.value).toMatchObject({ items: [], hasNext: false, total: 5 });
    for (const input of [{ page: 10_000, pageSize: 100 }, { pageSize: 101 }, { paging: 'x' }]) {
      const bad = await list.execute(admin(), input);
      expect(bad).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    }
  });

  it('refuses an unknown key, a bad value, and never lists another Market', async () => {
    const { list, admin, open } = setup();
    open('halal', 1, foreign);
    const stray = await list.execute(admin(), { nope: 1 });
    expect(stray).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    for (const input of [{ type: 'Bad Code' }, { q: 'abc' }, { sort: 'name' }, { page: 0 }]) {
      const bad = await list.execute(admin(), input);
      expect(bad).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    }
    const result = await list.execute(admin(), {});
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.items).toEqual([]);
    expect(result.value.counts).toEqual({ all: 0 });
  });

  it('says when more requests are open than the read cap', async () => {
    const { list, admin, open } = setup();
    for (let i = 0; i < 500; i += 1) open('halal', i);
    const result = await list.execute(admin(), { pageSize: 1 });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value).toMatchObject({ truncated: true, counts: { all: 500 } });
  });

  it('refuses a selector export when the read was cut at the cap, but exports chosen ids', async () => {
    const { exporter, admin, open } = setup();
    const first = open('halal', 0);
    for (let i = 1; i < 500; i += 1) open('halal', i);
    const whole = await exporter.execute(admin(), {});
    expect(whole).toMatchObject({ ok: false, error: { code: 'batch.too-large', max: 500 } });
    const chosen = await exporter.execute(admin(), { ids: first.id });
    expect(chosen.ok).toBe(true);
  });

  it('exports the list or the chosen ids as CSV with formula-safe cells', async () => {
    const { exporter, admin, open, names } = setup();
    const a = open('halal', 1);
    const b = open('kosher', 2);
    names.set(a.sellerId, '=HYPERLINK("x")');
    const all = await exporter.execute(admin(), { columns: 'request-id,documents' });
    if (!all.ok) throw new Error(JSON.stringify(all.error));
    expect(all.value.filename).toBe('issuer-requests-2026-10-10.csv');
    const body = await text(all.value);
    expect(body).toContain('Type,Store,Submitted (UTC),Request ID,Files');
    expect(body).toContain(`'=HYPERLINK`);
    expect(body).toContain(a.id);
    const some = await exporter.execute(admin(), { ids: b.id, format: 'csv' });
    if (!some.ok) throw new Error(JSON.stringify(some.error));
    const rows = (await text(some.value)).trim().split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('kosher');
  });

  it('refuses a whole export for an id that is not open in this Market', async () => {
    const { exporter, admin, open } = setup();
    const mine = open('halal', 1);
    const theirs = open('halal', 1, foreign);
    const result = await exporter.execute(admin(), { ids: `${mine.id},${theirs.id}` });
    expect(result).toMatchObject({ ok: false, error: { code: 'issuer-request.not-found' } });
    const dup = await exporter.execute(admin(), { ids: `${mine.id},${mine.id}` });
    expect(dup).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    const wrong = await exporter.execute(admin(), { format: 'pdf' });
    expect(wrong).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    // The chosen ids are the whole selection: a filter or sort beside them is refused.
    for (const extra of [{ sort: 'bogus' }, { type: 'halal' }, { q: mine.id }]) {
      const clash = await exporter.execute(admin(), { ids: mine.id, ...extra });
      expect(clash).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    }
    const tooMany = await exporter.execute(admin(), {
      ids: Array.from(
        { length: 201 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ).join(','),
    });
    expect(tooMany).toMatchObject({ ok: false, error: { code: 'batch.too-large', max: 200 } });
    const badColumn = await exporter.execute(admin(), { columns: 'typed-name' });
    expect(badColumn).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    const strayKey = await exporter.execute(admin(), { page: 2 });
    expect(strayKey).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
  });

  it('turns away a caller who is not an admin', async () => {
    const { list, open, ids } = setup();
    open('halal', 1);
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: ids.next<'Seller'>(),
      }),
    );
    const result = await list.execute(seller, {});
    expect(result).toMatchObject({ ok: false });
  });
});
