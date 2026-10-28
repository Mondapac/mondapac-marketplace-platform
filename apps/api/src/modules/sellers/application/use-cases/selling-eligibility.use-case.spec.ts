import {
  SequenceIdGenerator,
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccessState } from '../../domain/seller-status';
import { SellersFacadeImplementation } from '../../presentation/sellers.facade';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import type { BusinessIdentifierRule, SellerMarketPolicy } from '../ports/seller-market-policy';
import type {
  AllowedProductTypesSetting,
  ApprovedSellingFacts,
  SellingFactsRepository,
} from '../ports/selling-facts.repository';
import { AllowedProductTypesSystem } from './allowed-product-types-system.use-case';
import { AllowedProductTypes } from './allowed-product-types.use-case';
import { SellingEligibilitySystem } from './selling-eligibility-system.use-case';
import { SellingEligibility } from './selling-eligibility.use-case';

// The may-sell contract and allowedProductTypesOf (sellers design 7.1, 7.2; slice 9), with
// in-memory ports. Both Market fixtures: AU requires an identifier, ZZ does not. The PostgreSQL
// reads are covered by test/db/sellers-submit.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const ids = new SequenceIdGenerator(new FixedClock(Temporal.Instant.from('2026-10-10T10:00:00Z')));

class Store implements SellingFactsRepository {
  facts = new Map<string, ApprovedSellingFacts>();
  settings = new Map<string, AllowedProductTypesSetting>();
  fail = false;
  reads = 0;

  approvedSellingFacts(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, ApprovedSellingFacts>> {
    this.reads += 1;
    if (this.fail) return Promise.reject(new Error('read failed'));
    return Promise.resolve(
      new Map(
        sellerIds.flatMap((id) => {
          const found = this.facts.get(`${market.marketId}|${id}`);
          return found === undefined ? [] : [[id, found] as const];
        }),
      ),
    );
  }

  allowedProductTypes(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<AllowedProductTypesSetting | null> {
    if (this.fail) return Promise.reject(new Error('read failed'));
    return Promise.resolve(this.settings.get(`${market.marketId}|${sellerId}`) ?? null);
  }
}

class Access implements SellerAccessReader {
  states = new Map<string, AccessState>();
  fail = false;
  calls: Id<'Seller'>[][] = [];

  accessOf(): Promise<AccessState | null> {
    return Promise.reject(new Error('not used'));
  }

  reapplyLimitReachedOf(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  reapply(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  accessOfMany(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, AccessState>> {
    this.calls.push([...sellerIds]);
    if (this.fail) return Promise.reject(new Error('identity refused'));
    return Promise.resolve(
      new Map(
        sellerIds.flatMap((id) => {
          const state = this.states.get(`${context.market.marketId}|${id}`);
          return state === undefined ? [] : [[id, state] as const];
        }),
      ),
    );
  }
}

const unitOfWork: UnitOfWork & { readOnly: boolean[] } = {
  readOnly: [],
  async run<T, E>(
    _market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options?: { readOnly?: boolean },
  ) {
    unitOfWork.readOnly.push(options?.readOnly === true);
    return work();
  },
  runOnce: () => Promise.reject(new Error('not used')),
};

describe.each([
  ['AU', true],
  ['ZZ', false],
] as const)('sellingEligibility and allowedProductTypesOf, Market %s', (code, required) => {
  const market = () => testMarketContext(code, 'default');
  const anonymous = () => testCallContext(market(), 'anonymous');
  const system = () => testCallContext(market(), 'system');
  let store: Store;
  let access: Access;
  let rule: BusinessIdentifierRule | null;
  let facade: SellersFacadeImplementation;
  let request: SellingEligibility;
  let jobs: SellingEligibilitySystem;

  const approvedFacts: ApprovedSellingFacts = {
    hasIdentifier: true,
    operatingTimezone: code === 'AU' ? 'Australia/Brisbane' : 'Pacific/Auckland',
    openClaimConflict: false,
  };
  const approvedSeller = (
    facts: Partial<ApprovedSellingFacts> = {},
    state: AccessState = 'approved',
  ) => {
    const id = ids.next<'Seller'>();
    store.facts.set(`${code}|${id}`, { ...approvedFacts, ...facts });
    access.states.set(`${code}|${id}`, state);
    return id;
  };
  const eligible = async (context: CallContext, sellerIds: string[]) => {
    const result = await request.execute(context, { sellerIds });
    if (!result.ok) throw new Error(result.error.code);
    return [...result.value].map(([id, answer]) => [id, answer.eligible]);
  };

  beforeEach(() => {
    store = new Store();
    access = new Access();
    rule = { scheme: 'x', required, labelKey: 'x' };
    unitOfWork.readOnly.length = 0;
    const policy = {
      businessIdentifier: () => rule,
    } as unknown as SellerMarketPolicy;
    const deps = { unitOfWork, sellingFacts: store, accessReader: access, policy };
    request = new SellingEligibility(gate, deps);
    jobs = new SellingEligibilitySystem(gate, deps);
    facade = new SellersFacadeImplementation({
      sellerSummaries: undefined as never,
      publishedStoreSlugs: undefined as never,
      sellerSummariesSystem: undefined as never,
      sellingEligibility: request,
      sellingEligibilitySystem: jobs,
      allowedProductTypes: new AllowedProductTypes(gate, { unitOfWork, sellingFacts: store }),
      allowedProductTypesSystem: new AllowedProductTypesSystem(gate, {
        unitOfWork,
        sellingFacts: store,
      }),
      reviewerBusinessDetails: undefined as never,
      publishedStoreSellerId: undefined as never,
      carrierPickup: undefined as never,
      pickupPostcodes: undefined as never,
      operatingZones: undefined as never,
    });
  });

  it('says yes for an identity-approved seller with an approved revision, in one read-only unit', async () => {
    const yes = approvedSeller();

    expect(await eligible(anonymous(), [yes])).toEqual([[yes, true]]);
    expect(unitOfWork.readOnly).toEqual([true]);
    expect(access.calls).toEqual([[yes]]);
  });

  it('narrows identity`s yes and never widens its no', async () => {
    const pending = approvedSeller({}, 'pending');
    const suspended = approvedSeller({}, 'suspended');
    const rejected = approvedSeller({}, 'rejected');
    const conflict = approvedSeller({ openClaimConflict: true });
    const badZone = approvedSeller({ operatingTimezone: 'Not/AZone' });
    const emptyZone = approvedSeller({ operatingTimezone: '' });
    const offsetZone = approvedSeller({ operatingTimezone: '+05:30' });
    const wrongCase = approvedSeller({ operatingTimezone: 'australia/brisbane' });
    const noIdentifier = approvedSeller({ hasIdentifier: false });
    const unknownToIdentity = approvedSeller();
    access.states.delete(`${code}|${unknownToIdentity}`);
    const identityOnly = ids.next<'Seller'>();
    access.states.set(`${code}|${identityOnly}`, 'approved');
    const never = ids.next<'Seller'>();

    expect(
      await eligible(anonymous(), [
        pending,
        suspended,
        rejected,
        conflict,
        badZone,
        emptyZone,
        offsetZone,
        wrongCase,
        noIdentifier,
        unknownToIdentity,
        identityOnly,
        never,
      ]),
    ).toEqual([
      [pending, false],
      [suspended, false],
      [rejected, false],
      [conflict, false],
      [badZone, false],
      [emptyZone, false],
      [offsetZone, false],
      [wrongCase, false],
      // The Market's current rule decides (14.3 Q-M18): AU requires an identifier, ZZ does not.
      [noIdentifier, !required],
      [unknownToIdentity, false],
      [identityOnly, false],
      [never, false],
    ]);
    // identity is asked only for the ids sellers would allow, never for the rest.
    expect(access.calls[0]).not.toContain(identityOnly);
    expect(access.calls[0]).not.toContain(conflict);
  });

  it('answers no for a seller of another Market, byte-identical to an unknown id', async () => {
    const other = code === 'AU' ? 'ZZ' : 'AU';
    const elsewhere = ids.next<'Seller'>();
    store.facts.set(`${other}|${elsewhere}`, approvedFacts);
    access.states.set(`${other}|${elsewhere}`, 'approved');
    const never = ids.next<'Seller'>();

    expect(await eligible(anonymous(), [elsewhere, never])).toEqual([
      [elsewhere, false],
      [never, false],
    ]);
  });

  it('fails closed on a read error, an identity refusal and a Market with no identifier rule', async () => {
    const yes = approvedSeller();

    store.fail = true;
    expect(await eligible(anonymous(), [yes])).toEqual([[yes, false]]);
    store.fail = false;

    access.fail = true;
    expect(await eligible(anonymous(), [yes])).toEqual([[yes, false]]);
    access.fail = false;

    rule = null;
    const reads = store.reads;
    expect(await eligible(anonymous(), [yes])).toEqual([[yes, false]]);
    expect(store.reads).toBe(reads);
  });

  it('answers sellers.unavailable to the system on a read or identity error, so jobs retry', async () => {
    const yes = approvedSeller();
    const unavailable = { ok: false, error: { code: 'sellers.unavailable' } };

    store.fail = true;
    expect(await jobs.execute(system(), { sellerIds: [yes] })).toEqual(unavailable);
    store.fail = false;

    access.fail = true;
    expect(await jobs.execute(system(), { sellerIds: [yes] })).toEqual(unavailable);
    access.fail = false;

    // A Market with no identifier rule is an answer, not a fault: no for everyone.
    rule = null;
    expect(await jobs.execute(system(), { sellerIds: [yes] })).toEqual({
      ok: true,
      value: new Map([[yes, { eligible: false }]]),
    });
  });

  it('gives every caller the same answer, through the facade pair', async () => {
    const yes = approvedSeller();
    const no = approvedSeller({ openClaimConflict: true });
    const seller = testCallContext(
      market(),
      testAuthenticatedActor(market(), {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: yes,
      }),
    );

    const actor = (population: 'seller' | 'admin', sellerId: Id<'Seller'> | null) =>
      testCallContext(
        market(),
        testAuthenticatedActor(market(), {
          population,
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
      );
    const callers = [
      anonymous(),
      system(),
      seller,
      actor('seller', ids.next<'Seller'>()),
      actor('admin', null),
    ];
    const answers = await Promise.all(
      callers.map(async (context) => {
        const result = await facade.sellingEligibility(context, [yes, no]);
        return JSON.stringify(result.ok ? [...result.value] : result);
      }),
    );

    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0] ?? '')).toEqual([
      [yes, { eligible: true }],
      [no, { eligible: false }],
    ]);
  });

  it('keeps the batch rules: duplicates collapse, an empty list reads nothing, 101 ids are refused', async () => {
    const a = approvedSeller();
    expect(await eligible(anonymous(), [a, a])).toEqual([[a, true]]);

    const reads = store.reads;
    expect(await eligible(anonymous(), [])).toEqual([]);
    expect(store.reads).toBe(reads);

    const many = Array.from({ length: 101 }, () => ids.next<'Seller'>());
    expect(await request.execute(anonymous(), { sellerIds: many })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'length' }] },
    });
    expect(await request.execute(anonymous(), { sellerIds: ['not-an-id'] })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] },
    });
  });

  it('keeps each case to its own actor kind (the facade picks the pair)', async () => {
    const a = approvedSeller();

    expect((await jobs.execute(anonymous(), { sellerIds: [a] })).ok).toBe(false);
    expect((await request.execute(system(), { sellerIds: [a] })).ok).toBe(false);
  });

  it('answers allowedProductTypesOf: all with the setting on, nothing with it off, unavailable without a row', async () => {
    const on = ids.next<'Seller'>();
    const off = ids.next<'Seller'>();
    const missing = ids.next<'Seller'>();
    store.settings.set(`${code}|${on}`, 'all');
    store.settings.set(`${code}|${off}`, 'listed');

    const seller = testCallContext(
      market(),
      testAuthenticatedActor(market(), {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: on,
      }),
    );
    const admin = testCallContext(
      market(),
      testAuthenticatedActor(market(), {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    for (const context of [anonymous(), system(), seller, admin]) {
      expect(await facade.allowedProductTypesOf(context, on)).toEqual(ok('all'));
      expect(await facade.allowedProductTypesOf(context, off)).toEqual(ok(new Set()));
      expect(await facade.allowedProductTypesOf(context, missing)).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
    }

    store.fail = true;
    expect(await facade.allowedProductTypesOf(anonymous(), on)).toEqual({
      ok: false,
      error: { code: 'sellers.unavailable' },
    });
    store.fail = false;

    const other = code === 'AU' ? 'ZZ' : 'AU';
    const elsewhere = ids.next<'Seller'>();
    store.settings.set(`${other}|${elsewhere}`, 'all');
    expect((await facade.allowedProductTypesOf(anonymous(), elsewhere)).ok).toBe(false);
    expect((await facade.allowedProductTypesOf(anonymous(), 'not-an-id' as Id<'Seller'>)).ok).toBe(
      false,
    );
  });
});
