import {
  testAuthenticatedActor,
  SequenceIdGenerator,
  FixedClock,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import {
  InMemoryRevisions,
  TransactionalUnitOfWork,
} from '../../../../../test/support/sellers-submit-fakes';
import { newPendingRevision } from '../../domain/business-file-revision';
import { identifierIndexKeyOf } from '../../domain/business-identifier';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { ApprovedSellerZonesReaderImplementation } from '../../presentation/approved-seller-zones.reader';
import { ApprovedSellerZonesSystem } from './approved-seller-zones-system.use-case';
import { ApprovedSellerZones } from './approved-seller-zones.use-case';

// The contract of approvedSellerZones (sellers design 7.1a; certification #124): one entry per
// distinct id; { zone, addressZone } of the approved revision (slice 5b), nulls for any id with
// none. The PostgreSQL read is covered by test/db/sellers-submit.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');
const ids = new SequenceIdGenerator(new FixedClock(NOW));
const revisions = new InMemoryRevisions();
const unitOfWork = new TransactionalUnitOfWork([revisions]);
const deps = { unitOfWork, revisions };
const NONE = { zone: null, addressZone: null };

describe.each(['AU', 'ZZ'])('approvedSellerZones contract, Market %s', (code) => {
  const market = () => testMarketContext(code, 'default');
  const anonymous = () => testCallContext(market(), 'anonymous');
  const system = () => testCallContext(market(), 'system');
  const request = new ApprovedSellerZones(gate, deps);
  const jobs = new ApprovedSellerZonesSystem(gate, deps);
  const facade = new ApprovedSellerZonesReaderImplementation({
    approvedSellerZones: request,
    approvedSellerZonesSystem: jobs,
  });

  it('answers the pair of nulls, one key per distinct id, in first-occurrence order', async () => {
    const a = ids.next<'Seller'>();
    const b = ids.next<'Seller'>();
    const c = ids.next<'Seller'>();

    const result = await request.execute(anonymous(), { sellerIds: [b, a, b, c, a] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.keys()]).toEqual([b, a, c]);
    expect([...result.value.values()]).toEqual([NONE, NONE, NONE]);
  });

  it('answers an empty list with an empty map', async () => {
    const result = await request.execute(anonymous(), { sellerIds: [] });

    expect(result.ok && result.value.size).toBe(0);
  });

  it('accepts 100 distinct ids and refuses 101 entries, 101 duplicates and a malformed id whole', async () => {
    const hundred = Array.from({ length: 100 }, () => ids.next<'Seller'>());
    const accepted = await request.execute(anonymous(), { sellerIds: hundred });
    expect(accepted.ok && accepted.value.size).toBe(100);

    const duplicates = Array.from({ length: 101 }, () => hundred[0] as string);
    for (const [sellerIds, fieldCode] of [
      [[...hundred, ids.next<'Seller'>()], 'length'],
      [duplicates, 'length'],
      [['not-an-id'], 'format'],
      [[42 as unknown as string], 'format'],
    ] as const) {
      for (const useCase of [request, jobs]) {
        const refused = await useCase.execute(useCase === request ? anonymous() : system(), {
          sellerIds,
        });
        expect(refused).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: fieldCode }] },
        });
      }
    }
  });

  it('gives byte-identical answers to every caller, an issued id and a never-issued one alike', async () => {
    const batch = [
      ids.next<'Seller'>(),
      '0197f2a0-0000-7000-8000-000000000000',
      ids.next<'Seller'>(),
    ];
    const bytes = (r: { ok: boolean; value?: ReadonlyMap<string, unknown> }) =>
      JSON.stringify(r.ok ? [...(r.value ?? [])] : r);

    const fromRequest = await facade.approvedSellerZones(anonymous(), batch as never);
    const fromJob = await facade.approvedSellerZones(system(), batch as never);

    expect(fromRequest.ok && fromJob.ok).toBe(true);
    expect(bytes(fromJob as never)).toBe(bytes(fromRequest as never));
  });

  it('gives byte-identical answers under every actor kind and for ids of the other Market', async () => {
    const owned = ids.next<'Seller'>();
    const other = ids.next<'Seller'>();
    // An id issued for the other Market is only an id here: its entry is the same as any other.
    const foreign = ids.next<'Seller'>();
    const batch = [owned, other, foreign, '0197f2a0-0000-7000-8000-000000000000'];
    const person = (population: 'seller' | 'admin', sellerId: typeof owned | null) =>
      testAuthenticatedActor(market(), {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      });
    const actors = [
      'anonymous',
      'system',
      person('seller', owned),
      person('seller', other),
      person('admin', null),
    ] as const;

    const answers: string[] = [];
    for (const actor of actors) {
      const ran: string[] = [];
      const traced = new ApprovedSellerZonesReaderImplementation({
        approvedSellerZones: {
          execute: (c: never, i: never) => (ran.push('anonymous'), request.execute(c, i)),
        } as never,
        approvedSellerZonesSystem: {
          execute: (c: never, i: never) => (ran.push('system'), jobs.execute(c, i)),
        } as never,
      });
      const result = await traced.approvedSellerZones(
        testCallContext(market(), actor),
        batch as never,
      );
      // Facade level: the system case runs for the system actor only.
      expect(ran).toEqual([actor === 'system' ? 'system' : 'anonymous']);
      expect(result.ok).toBe(true);
      answers.push(JSON.stringify(result.ok ? [...result.value] : result));
    }
    expect(new Set(answers).size).toBe(1);
  });

  it('refuses an upper-case id whole, so ids differing only in case never collapse', async () => {
    const a = ids.next<'Seller'>();

    const refused = await request.execute(anonymous(), { sellerIds: [a, a.toUpperCase()] });

    expect(refused).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] },
    });
  });

  it('refuses a non-array input whole', async () => {
    for (const sellerIds of [null, 'text', {}, 7]) {
      const refused = await request.execute(anonymous(), { sellerIds: sellerIds as never });
      expect(refused).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'length' }] },
      });
    }
  });

  it('keeps each case to its own actor kind (the facade picks the pair)', async () => {
    const a = ids.next<'Seller'>();

    expect((await jobs.execute(anonymous(), { sellerIds: [a] })).ok).toBe(false);
    expect((await request.execute(system(), { sellerIds: [a] })).ok).toBe(false);
  });
});

/** Puts a revision of the given status in the store, the way a decision would leave it. */
function revision(
  code: string,
  sellerId: ReturnType<typeof ids.next<'Seller'>>,
  status: 'pending' | 'approved' | 'withdrawn',
  zones: { operatingTimezone: string; addressTimezone: string | null },
): void {
  const base = newPendingRevision({
    id: ids.next<'BusinessFileRevision'>(),
    sellerId,
    kind: 'onboarding',
    revisionNo: 1,
    authorKind: 'seller',
    authorAccountId: ids.next<'Account'>(),
    snapshot: {
      ...zones,
      serviceAreaCode: 'area-1',
      identifierIndex: identifierIndexKeyOf(new Uint8Array(32).fill(1)),
    },
    contentHash: `hmac-sha256:${'a'.repeat(64)}` as never,
    register: { outcome: 'not-performed', mismatches: [], checkedAt: null },
    now: NOW,
  });
  const market = testMarketContext(code, 'default');
  const row = {
    ...base,
    status,
    decidedAt: status === 'approved' ? NOW : null,
    decidedByAccountId: status === 'approved' ? ids.next<'Account'>() : null,
  };
  void revisions.add(market, row, {
    ciphertext: 'sealed.x' as never,
    contentHash: row.contentHash,
  });
}

describe.each(['AU', 'ZZ'])('approvedSellerZones with approved revisions, Market %s', (code) => {
  const market = () => testMarketContext(code, 'default');
  const anonymous = () => testCallContext(market(), 'anonymous');
  const request = new ApprovedSellerZones(gate, deps);
  const jobs = new ApprovedSellerZonesSystem(gate, deps);

  it('answers the approved revision zones, and nulls for pending, withdrawn and unknown sellers', async () => {
    const approved = ids.next<'Seller'>();
    const pending = ids.next<'Seller'>();
    const withdrawn = ids.next<'Seller'>();
    const noAddress = ids.next<'Seller'>();
    const unknown = ids.next<'Seller'>();
    revision(code, approved, 'approved', {
      operatingTimezone: 'Pacific/Auckland',
      addressTimezone: 'Pacific/Chatham',
    });
    revision(code, pending, 'pending', {
      operatingTimezone: 'Asia/Tokyo',
      addressTimezone: 'Asia/Tokyo',
    });
    revision(code, withdrawn, 'withdrawn', {
      operatingTimezone: 'Asia/Tokyo',
      addressTimezone: 'Asia/Tokyo',
    });
    revision(code, noAddress, 'approved', {
      operatingTimezone: 'Asia/Tokyo',
      addressTimezone: null,
    });

    const batch = [unknown, approved, pending, approved, withdrawn, noAddress];
    for (const result of [
      await request.execute(anonymous(), { sellerIds: batch }),
      await jobs.execute(testCallContext(market(), 'system'), { sellerIds: batch }),
    ]) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect([...result.value]).toEqual([
        [unknown, NONE],
        [approved, { zone: 'Pacific/Auckland', addressZone: 'Pacific/Chatham' }],
        [pending, NONE],
        [withdrawn, NONE],
        [noAddress, { zone: 'Asia/Tokyo', addressZone: null }],
      ]);
    }
  });

  it('never answers a seller approved in the other Market', async () => {
    const other = code === 'AU' ? 'ZZ' : 'AU';
    const seller = ids.next<'Seller'>();
    revision(other, seller, 'approved', {
      operatingTimezone: 'Asia/Tokyo',
      addressTimezone: 'Asia/Tokyo',
    });

    const result = await request.execute(anonymous(), { sellerIds: [seller] });

    expect(result.ok && [...result.value]).toEqual([[seller, NONE]]);
  });

  it('fails closed with sellers.unavailable when the read fails, never nulls', async () => {
    const broken = new ApprovedSellerZones(gate, {
      unitOfWork,
      revisions: {
        approvedZones: () => Promise.reject(new Error('database down')),
      } as never,
    });

    const result = await broken.execute(anonymous(), { sellerIds: [ids.next<'Seller'>()] });

    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
  });

  it('reads nothing for an empty list', async () => {
    const reads: boolean[] = [];
    const counting = new ApprovedSellerZones(gate, {
      unitOfWork: {
        run: (market, work, options) => (reads.push(true), unitOfWork.run(market, work, options)),
        runOnce: unitOfWork.runOnce.bind(unitOfWork),
      },
      revisions,
    });

    const result = await counting.execute(anonymous(), { sellerIds: [] });

    expect(result.ok && result.value.size).toBe(0);
    expect(reads).toEqual([]);
  });
});

it('answers the same bytes under AU and ZZ', async () => {
  const request = new ApprovedSellerZones(gate, deps);
  const a = ids.next<'Seller'>();

  const au = await request.execute(
    testCallContext(testMarketContext('AU', 'default'), 'anonymous'),
    { sellerIds: [a] },
  );
  const zz = await request.execute(
    testCallContext(testMarketContext('ZZ', 'default'), 'anonymous'),
    { sellerIds: [a] },
  );

  expect(JSON.stringify([...(au.ok ? au.value : [])])).toBe(
    JSON.stringify([...(zz.ok ? zz.value : [])]),
  );
});
