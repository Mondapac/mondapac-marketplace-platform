import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { CertificationFacadeImplementation } from '../../presentation/certification.facade';
import type { ClaimQuery, CertificationTypeCode, TimeZoneId } from '../../domain/claim-types';
import type { SellerCertificationView } from '../../domain/validity';
import type {
  ClaimFactsReader,
  SellerZoneAnswer,
  SellerZonesSource,
  TypeAndPolicy,
} from '../ports/claim-facts.ports';
import { EvaluateClaimsSystem } from './evaluate-claims-system.use-case';
import { EvaluateClaims } from './evaluate-claims.use-case';

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);
const clock = new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z'));
const ids = new SequenceIdGenerator(clock);
const code = (s: string): CertificationTypeCode => s as CertificationTypeCode;
const zoneId = (s: string): TimeZoneId => s as TimeZoneId;

// Per Market: a different type, zone and expiry, so a test that passes only for AU would fail.
const MARKET_FIXTURE = {
  AU: { type: 'halal', zone: 'Australia/Sydney', other: 'Australia/Brisbane' },
  ZZ: { type: 'zed-pure', zone: 'Pacific/Auckland', other: 'Pacific/Honolulu' },
} as const;

interface World {
  type: TypeAndPolicy['type'];
  rows: { basis: 'SELLER_REQUIRED' | 'NOT_APPLICABLE' | 'SELLER_OR_MANUFACTURER' }[];
  certificate: SellerCertificationView | null;
  zones: { zone: string | null; addressZone: string | null } | 'absent';
  failRead: boolean;
  misaligned: boolean;
  extraZoneKey: boolean;
}
let world: World;
const calls = { policies: 0, certificates: 0, zones: 0 };

const facts: ClaimFactsReader = {
  typesAndPolicies: (_m, requests) => {
    calls.policies += 1;
    if (world.failRead) return Promise.reject(new Error('db down'));
    const one: TypeAndPolicy = {
      type: world.type,
      policy: world.rows.length > 0 ? { revisionId: ids.next(), matchedRows: world.rows } : null,
    };
    const list = requests.map(() => one);
    return Promise.resolve(world.misaligned ? list.slice(1) : list);
  },
  sellerCertificates: (_m, requests) => {
    calls.certificates += 1;
    return Promise.resolve(requests.map(() => world.certificate));
  },
};
const zones: SellerZonesSource = {
  zonesOf: (_c, sellerIds) => {
    calls.zones += 1;
    const answer = new Map(
      sellerIds.map((id) => [id, world.zones === 'absent' ? undefined : world.zones] as const),
    ) as unknown as Map<Id<'Seller'>, { zone: string | null; addressZone: string | null }>;
    if (world.zones === 'absent') answer.clear();
    if (world.extraZoneKey) answer.set(ids.next<'Seller'>(), { zone: null, addressZone: null });
    return Promise.resolve(answer as SellerZoneAnswer);
  },
};

describe.each(['AU', 'ZZ'] as const)('evaluateClaims, Market %s', (marketCode) => {
  const fx = MARKET_FIXTURE[marketCode];
  const market = () => testMarketContext(marketCode, 'default');
  const anonymous = () => testCallContext(market(), 'anonymous');
  const system = () => testCallContext(market(), 'system');
  const request = new EvaluateClaims(gate, facts, zones, clock);
  const jobs = new EvaluateClaimsSystem(gate, facts, zones, clock);
  const facade = new CertificationFacadeImplementation({
    evaluateClaims: request,
    evaluateClaimsSystem: jobs,
    matchClaimTerms: undefined as never,
    matchClaimTermsSystem: undefined as never,
    certificationTypes: undefined as never,
    certificationTypesSystem: undefined as never,
  });

  const query = (over: Partial<ClaimQuery> = {}): ClaimQuery => ({
    sellerId: ids.next<'Seller'>(),
    productId: ids.next<'Product'>(),
    productRevisionId: ids.next<'ProductRevision'>(),
    variantId: null,
    typeCode: code(fx.type),
    handling: 'SEALED_ORIGINAL',
    attestationRecorded: true,
    platformCategoryPaths: [[ids.next<'Category'>(), ids.next<'Category'>()]],
    ...over,
  });
  const approved = (expiry: string, issuerState = 'active'): SellerCertificationView => ({
    certificateId: ids.next(),
    status: 'approved',
    approved: {
      submissionId: ids.next(),
      typeRevisionId: ids.next(),
      requiresExpiry: true,
      expiryDate: Temporal.PlainDate.from(expiry),
      zoneAtApproval: zoneId(fx.zone),
      issuerId: ids.next(),
      issuerState: issuerState as never,
    },
  });

  beforeEach(() => {
    world = {
      type: { publishedRevisionId: ids.next(), defaultBasis: 'SELLER_REQUIRED' },
      rows: [],
      certificate: approved('2027-01-31'),
      zones: { zone: fx.zone, addressZone: fx.zone },
      failRead: false,
      misaligned: false,
      extraZoneKey: false,
    };
    calls.policies = calls.certificates = calls.zones = 0;
  });

  it('allows a valid seller certificate, echoes the inputs and gives both callers the same answer', async () => {
    const q = query();
    const a = await facade.evaluateClaims(anonymous(), [q]);
    const s = await facade.evaluateClaims(system(), [q]);
    expect(a.ok && a.value[0]).toEqual(
      expect.objectContaining({ allowed: true, basis: 'SELLER', reason: 'allowed', inputs: q }),
    );
    expect(a.ok && a.value[0]!.evaluatedAt).toEqual(clock.now());
    expect(JSON.stringify(a)).toBe(JSON.stringify(s));
  });

  it.each([
    [
      'no certificate',
      (): void => {
        world.certificate = null;
      },
      'no-valid-seller-certificate',
    ],
    [
      'an expired certificate',
      (): void => {
        world.certificate = approved('2026-10-07');
      },
      'no-valid-seller-certificate',
    ],
    [
      'a derecognised issuer',
      (): void => {
        world.certificate = approved('2027-01-31', 'derecognised');
      },
      'no-valid-seller-certificate',
    ],
    [
      'a missing zone',
      (): void => {
        world.zones = { zone: null, addressZone: fx.zone };
      },
      'seller-zone-missing',
    ],
    [
      'a missing address zone',
      (): void => {
        world.zones = { zone: fx.zone, addressZone: null };
      },
      'seller-zone-missing',
    ],
    [
      'no zone answer for the seller',
      (): void => {
        world.zones = 'absent';
      },
      'seller-zone-missing',
    ],
    [
      'an unknown type',
      (): void => {
        world.type = null;
      },
      'type-unknown',
    ],
    [
      'a NOT_APPLICABLE row',
      (): void => {
        world.rows = [{ basis: 'NOT_APPLICABLE' }];
      },
      'policy-not-applicable',
    ],
  ] as const)('denies %s', async (_name, arrange, reason) => {
    arrange();
    const r = await facade.evaluateClaims(anonymous(), [query()]);
    expect(r.ok && r.value[0]).toEqual(expect.objectContaining({ allowed: false, reason }));
  });

  it('applies the expiry boundary of the seller zone through the use case (the zone maths are in validity.spec)', async () => {
    // Expiry date is today in the later zone; the boundary of the earlier zone has passed.
    const day = '2026-10-08';
    world.certificate = approved(day);
    world.zones = { zone: fx.zone, addressZone: fx.other };
    const r = await facade.evaluateClaims(anonymous(), [query()]);
    expect(r.ok && r.value[0]!.allowed).toBe(true); // the day after is still ahead of 10:00Z
    world.certificate = approved('2026-10-07');
    const over = await facade.evaluateClaims(anonymous(), [query()]);
    expect(over.ok && over.value[0]!.allowed).toBe(false);
  });

  it('answers input-invalid for a malformed query and still answers the others', async () => {
    const good = query();
    const bad = [
      { ...good, sellerId: 'nope' },
      { ...good, handling: 'EXOTIC' },
      { ...good, typeCode: 'Bad Code' },
      { ...good, attestationRecorded: 'yes' },
      { ...good, platformCategoryPaths: [[]] },
      { ...good, platformCategoryPaths: 'x' },
      { ...good, variantId: 7 },
      null,
    ];
    const r = await facade.evaluateClaims(anonymous(), [...bad, good] as never);
    expect(r.ok && r.value.map((d) => d.reason)).toEqual([
      ...bad.map(() => 'input-invalid'),
      'allowed',
    ]);
  });

  it('fails the whole batch closed on a read fault, still refusing the malformed ones', async () => {
    world.failRead = true;
    const q = query();
    const r = await facade.evaluateClaims(system(), [q, null as never]);
    expect(r.ok && r.value.map((d) => [d.allowed, d.reason])).toEqual([
      [false, 'unavailable'],
      [false, 'input-invalid'],
    ]);
  });

  it('fails closed on a misaligned read and on an unexpected zone key', async () => {
    world.misaligned = true;
    const a = await facade.evaluateClaims(anonymous(), [query(), query()]);
    expect(a.ok && a.value.every((d) => d.reason === 'unavailable')).toBe(true);
    world.misaligned = false;
    world.extraZoneKey = true;
    const b = await facade.evaluateClaims(anonymous(), [query()]);
    expect(b.ok && b.value[0]!.reason).toBe('unavailable');
  });

  it('asks sellers for zones only when a query can still be decided by a certificate', async () => {
    world.type = null;
    await facade.evaluateClaims(anonymous(), [query(), query()]);
    expect(calls).toEqual({ policies: 1, certificates: 1, zones: 0 });
  });

  it('refuses an empty batch, 101 queries and a non-array, and accepts exactly 100', async () => {
    for (const bad of [[], Array.from({ length: 101 }, () => query()), 'x']) {
      const r = await facade.evaluateClaims(anonymous(), bad as never);
      expect(r.ok).toBe(false);
    }
    const hundred = await facade.evaluateClaims(
      anonymous(),
      Array.from({ length: 100 }, () => query()),
    );
    expect(hundred.ok && hundred.value.length).toBe(100);
    expect(calls.policies).toBe(1); // one statement per batch, not per query
  });

  it('gates the pair and reads no actor: every request actor gets the same bytes, system is refused', async () => {
    const q = query();
    const person = (population: 'seller' | 'admin') =>
      testAuthenticatedActor(market(), {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? q.sellerId : null,
      });
    const answers = new Set<string>();
    for (const actor of ['anonymous', person('seller'), person('admin')] as const) {
      const r = await request.execute(testCallContext(market(), actor), { queries: [q] });
      answers.add(JSON.stringify(r));
    }
    expect(answers.size).toBe(1);
    expect(await request.execute(system(), { queries: [q] })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(await jobs.execute(anonymous(), { queries: [q] })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });
});
