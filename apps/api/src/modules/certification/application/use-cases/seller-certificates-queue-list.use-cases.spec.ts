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
import { CERTIFICATION_SELLER_CERTIFICATE_APPROVE } from '../../contracts/permissions';
import type { SubmissionKind } from '../../domain/seller-certificate';
import type { CertificateQueueListDependencies } from '../review/certificate-queue-list-flow';
import type { CertificateReviewRepository, ReviewQueueEntry } from '../ports/review.repository';
import { SellerCertificatesQueueExport } from './seller-certificates-queue-export.use-case';
import { SellerCertificatesQueueQuery } from './seller-certificates-queue-query.use-case';

// The certificates queue super list (list 17) and its export in memory, on both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-10T10:00:00Z');

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}

describe.each(['AU', 'ZZ'] as const)('certificate queue list and export in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const foreign: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');

  function setup(options: { mayApprove?: boolean; namesFail?: boolean } = {}) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const byMarket = new Map<string, ReviewQueueEntry[]>();
    const reviews = {
      queue: (m: MarketContext, limit: number) =>
        Promise.resolve((byMarket.get(m.marketId) ?? []).slice(0, limit)),
    } as unknown as CertificateReviewRepository;
    const names = new Map<Id<'Seller'>, string>();
    const deps: CertificateQueueListDependencies = {
      unitOfWork: passThroughUnitOfWork,
      reviews,
      sellers: {
        storeNames: () =>
          options.namesFail === true
            ? Promise.reject(new Error('sellers down'))
            : Promise.resolve(names),
        businessDetails: () => Promise.reject(new Error('not used')),
      },
      probes: {
        [CERTIFICATION_SELLER_CERTIFICATE_APPROVE.key]: {
          execute: () => Promise.resolve({ ok: options.mayApprove ?? true }),
        },
      },
      sheetWriter: new ExceljsSheetWriter(),
      clock,
    };
    const list = new SellerCertificatesQueueQuery(gate, deps);
    const exporter = new SellerCertificatesQueueExport(gate, deps);
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
    function wait(
      typeCode: string,
      kind: SubmissionKind,
      hoursAfter: number,
      m: MarketContext = market,
    ) {
      const entry: ReviewQueueEntry = {
        certificateId: ids.next<'SellerCertification'>(),
        version: 1,
        sellerId: ids.next<'Seller'>(),
        typeCode,
        submissionId: ids.next<'Submission'>(),
        submissionNo: 1,
        kind,
        submittedAt: T0.add({ hours: hoursAfter }),
        issuerName: 'Issuer One',
      };
      byMarket.set(m.marketId, [...(byMarket.get(m.marketId) ?? []), entry]);
      return entry;
    }
    const ask = async (input: Record<string, unknown>) => {
      const result = await list.execute(admin(), input);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    };
    return { list, exporter, admin, wait, names, ids, ask };
  }

  it('lists renewals first, then oldest, with counts, actions and store names', async () => {
    const { ask, wait, names } = setup();
    const late = wait('halal', 'initial', 5);
    const early = wait('halal', 'initial', 1);
    const renewal = wait('kosher', 'renewal', 9);
    names.set(early.sellerId, 'Early Store');
    const page = await ask({});
    expect(page.items.map((r) => r.certificateId)).toEqual([
      renewal.certificateId,
      early.certificateId,
      late.certificateId,
    ]);
    expect(page.items[1]).toMatchObject({
      storeName: 'Early Store',
      issuerName: 'Issuer One',
      actions: ['open', 'decide'],
    });
    expect(page.counts).toEqual({ all: 3, initial: 2, resubmission: 0, renewal: 1 });
    expect(page).toMatchObject({ total: 3, truncated: false });
  });

  it('offers only Open to a caller who may not approve, and lists when names fail', async () => {
    const { list, admin, wait } = setup({ mayApprove: false, namesFail: true });
    wait('halal', 'initial', 1);
    const result = await list.execute(admin(), {});
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.items[0]?.actions).toEqual(['open']);
    expect(result.value.items[0]?.storeName).toBeNull();
  });

  it('filters by view, kind, type, seller, id and submission range', async () => {
    const { ask, wait } = setup();
    const a = wait('halal', 'initial', 1);
    const b = wait('kosher', 'resubmission', 3);
    const c = wait('halal', 'renewal', 6);
    const idsOf = async (input: Record<string, unknown>) =>
      (await ask(input)).items.map((r) => r.certificateId);
    expect(await idsOf({ view: 'resubmission' })).toEqual([b.certificateId]);
    expect(await idsOf({ kind: 'renewal' })).toEqual([c.certificateId]);
    expect(await idsOf({ type: 'kosher' })).toEqual([b.certificateId]);
    expect(await idsOf({ sellerId: a.sellerId })).toEqual([a.certificateId]);
    expect(await idsOf({ q: a.submissionId })).toEqual([a.certificateId]);
    expect(await idsOf({ q: b.certificateId.toUpperCase() })).toEqual([b.certificateId]);
    expect(
      await idsOf({ from: T0.add({ hours: 3 }).toString(), to: T0.add({ hours: 6 }).toString() }),
    ).toEqual([b.certificateId]);
  });

  it('sorts by time and type and keeps renewals first only in the queue order', async () => {
    const { ask, wait } = setup();
    const a = wait('kosher', 'initial', 1);
    const b = wait('halal', 'initial', 2);
    const r = wait('halal', 'renewal', 3);
    const idsOf = async (input: Record<string, unknown>) =>
      (await ask(input)).items.map((x) => x.certificateId);
    expect(await idsOf({ sort: 'queue', direction: 'desc' })).toEqual([
      r.certificateId,
      b.certificateId,
      a.certificateId,
    ]);
    expect(await idsOf({ sort: 'submitted', direction: 'desc' })).toEqual([
      r.certificateId,
      b.certificateId,
      a.certificateId,
    ]);
    const byType = await idsOf({ sort: 'type', direction: 'asc' });
    expect(byType[2]).toBe(a.certificateId);
  });

  it('pages with a total, or Previous/Next without one, and refuses bad paging', async () => {
    const { ask, wait, list, admin } = setup();
    for (let i = 0; i < 5; i += 1) wait('halal', 'initial', i);
    expect(await ask({ page: 2, pageSize: 2 })).toMatchObject({ total: 5, hasNext: true });
    const prevNext = await ask({ page: 3, pageSize: 2, paging: 'prev-next' });
    expect(prevNext).toMatchObject({ total: null, hasNext: false });
    expect(prevNext.items).toHaveLength(1);
    expect(await ask({ page: 9, pageSize: 2 })).toMatchObject({ items: [], hasNext: false });
    for (const input of [
      { page: 10_000, pageSize: 100 },
      { pageSize: 101 },
      { paging: 'x' },
      { nope: 1 },
      { type: 'Bad Code' },
      { q: 'abc' },
      { view: 'done' },
    ]) {
      expect(await list.execute(admin(), input)).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    }
  });

  it('never lists another Market and says when the read was cut at the cap', async () => {
    const { ask, wait } = setup();
    wait('halal', 'initial', 1, foreign);
    expect(await ask({})).toMatchObject({ items: [], counts: { all: 0 }, truncated: false });
    for (let i = 0; i < 500; i += 1) wait('halal', 'initial', i);
    expect(await ask({ pageSize: 1 })).toMatchObject({ truncated: true, counts: { all: 500 } });
  });

  it('exports the list or the chosen ids as CSV with formula-safe cells', async () => {
    const { exporter, admin, wait, names } = setup();
    const a = wait('halal', 'initial', 1);
    const b = wait('kosher', 'renewal', 2);
    names.set(a.sellerId, '=HYPERLINK("x")');
    const all = await exporter.execute(admin(), { columns: 'certificate-id,submission-no' });
    if (!all.ok) throw new Error(JSON.stringify(all.error));
    expect(all.value.filename).toBe('certificate-queue-2026-10-10.csv');
    const body = await text(all.value);
    expect(body).toContain('Type,Kind,Store,Issuer,Submitted (UTC),Certificate ID,Submission no.');
    expect(body).toContain(`'=HYPERLINK`);
    const some = await exporter.execute(admin(), { ids: b.certificateId });
    if (!some.ok) throw new Error(JSON.stringify(some.error));
    const rows = (await text(some.value)).trim().split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('kosher');
  });

  it('refuses bad exports whole', async () => {
    const { exporter, admin, wait } = setup();
    const mine = wait('halal', 'initial', 1);
    const theirs = wait('halal', 'initial', 1, foreign);
    const run = (input: Record<string, unknown>) => exporter.execute(admin(), input);
    expect(await run({ ids: `${mine.certificateId},${theirs.certificateId}` })).toMatchObject({
      ok: false,
      error: { code: 'certificate.not-found' },
    });
    for (const input of [
      { ids: `${mine.certificateId},${mine.certificateId}` },
      { ids: mine.certificateId, sort: 'bogus' },
      { ids: mine.certificateId, type: 'halal' },
      { format: 'pdf' },
      { columns: 'number' },
      { page: 2 },
    ]) {
      expect(await run(input)).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    }
    const many = Array.from(
      { length: 201 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    ).join(',');
    expect(await run({ ids: many })).toMatchObject({
      ok: false,
      error: { code: 'batch.too-large', max: 200 },
    });
  });

  it('refuses a selector export cut at the cap, but exports chosen ids', async () => {
    const { exporter, admin, wait } = setup();
    const first = wait('halal', 'initial', 0);
    for (let i = 1; i < 500; i += 1) wait('halal', 'initial', i);
    expect(await exporter.execute(admin(), {})).toMatchObject({
      ok: false,
      error: { code: 'batch.too-large', max: 500 },
    });
    expect((await exporter.execute(admin(), { ids: first.certificateId })).ok).toBe(true);
  });

  it('turns away a caller who is not an admin', async () => {
    const { list, wait, ids } = setup();
    wait('halal', 'initial', 1);
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: ids.next<'Seller'>(),
      }),
    );
    expect(await list.execute(seller, {})).toMatchObject({ ok: false });
  });
});
