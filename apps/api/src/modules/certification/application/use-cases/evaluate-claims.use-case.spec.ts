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
  /** Per-request overrides, keyed by type code / `seller|type` / seller id. */
  typeOf: Map<string, TypeAndPolicy['type']>;
  certOf: Map<string, SellerCertificationView | null>;
  zonesOf: Map<string, { zone: string | null; addressZone: string | null }>;
  failCertificates: boolean;
  failZones: boolean;
  misalignedCertificates: boolean;
  /** Answers of the right count whose keys are not the requested ones (a reordered read). */
  shuffledAnswers: boolean;
  wrongSellerCertificates: boolean;
  wrongTypeCertificates: boolean;
}
const POLICY_REVISION = '0197f2a0-0000-7000-8000-0000000000aa' as Id;
let world: World;
const calls = { policies: 0, certificates: 0, zones: 0 };
let zoneRequests: string[][] = [];
let policyRequests: { typeCode: string; categoryIds: readonly string[]; handling: string }[] = [];

const facts: ClaimFactsReader = {
  typesAndPolicies: (_m, requests) => {
    calls.policies += 1;
    policyRequests = requests.map((r) => ({ ...r }));
    if (world.failRead) return Promise.reject(new Error('db down'));
    const list = requests.map((r): TypeAndPolicy => ({
      typeCode: r.typeCode,
      type: world.typeOf.has(r.typeCode) ? (world.typeOf.get(r.typeCode) ?? null) : world.type,
      policy:
        world.rows.length > 0 ? { revisionId: POLICY_REVISION, matchedRows: world.rows } : null,
    }));
    return Promise.resolve(
      world.misaligned
        ? list.slice(1)
        : world.shuffledAnswers
          ? list.map((a) => ({ ...a, typeCode: code('some-other-type') }))
          : list,
    );
  },
  sellerCertificates: (_m, requests) => {
    calls.certificates += 1;
    if (world.failCertificates) return Promise.reject(new Error('db down'));
    const list = requests.map((r) => {
      const key = `${r.sellerId}|${r.typeCode}`;
      return {
        sellerId: r.sellerId,
        typeCode: r.typeCode,
        certificate: world.certOf.has(key) ? (world.certOf.get(key) ?? null) : world.certificate,
      };
    });
    return Promise.resolve(
      world.misalignedCertificates
        ? list.slice(1)
        : world.wrongSellerCertificates
          ? list.map((a) => ({ ...a, sellerId: ids.next<'Seller'>() }))
          : world.wrongTypeCertificates
            ? list.map((a) => ({ ...a, typeCode: code('some-other-type') }))
            : list,
    );
  },
};
const zones: SellerZonesSource = {
  zonesOf: (_c, sellerIds) => {
    calls.zones += 1;
    zoneRequests.push([...sellerIds]);
    if (world.failZones) return Promise.reject(new Error('sellers unavailable'));
    const answer = new Map(
      sellerIds.map(
        (id) =>
          [
            id,
            world.zones === 'absent' ? undefined : (world.zonesOf.get(id) ?? world.zones),
          ] as const,
      ),
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
      typeOf: new Map(),
      certOf: new Map(),
      zonesOf: new Map(),
      failCertificates: false,
      failZones: false,
      misalignedCertificates: false,
      shuffledAnswers: false,
      wrongSellerCertificates: false,
      wrongTypeCertificates: false,
    };
    zoneRequests = [];
    policyRequests = [];
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
    // An expiry date of today is valid until the start of tomorrow in the seller's zone; a date
    // of yesterday is over for every zone at this instant.
    world.certificate = approved('2026-10-08');
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

  it('asks for certificates and zones only when a query has a seller basis to decide', async () => {
    world.type = null;
    await facade.evaluateClaims(anonymous(), [query(), query()]);
    expect(calls).toEqual({ policies: 1, certificates: 0, zones: 0 });
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

  it('keeps order and alignment in a mixed batch (allowed, unknown type, invalid, not applicable, zone missing)', async () => {
    const allowedQ = query();
    const unknownQ = query({ typeCode: code('unknown-type') });
    const naQ = query({ typeCode: code('na-type') });
    const noZoneQ = query();
    const lateAllowedQ = query();
    world.typeOf.set('unknown-type', null);
    world.typeOf.set('na-type', {
      publishedRevisionId: ids.next(),
      defaultBasis: 'NOT_APPLICABLE',
    });
    world.zonesOf.set(noZoneQ.sellerId, { zone: null, addressZone: fx.zone });
    const r = await facade.evaluateClaims(anonymous(), [
      unknownQ,
      allowedQ,
      null as never,
      naQ,
      noZoneQ,
      lateAllowedQ,
    ]);
    expect(r.ok && r.value.map((d) => d.reason)).toEqual([
      'type-unknown',
      'allowed',
      'input-invalid',
      'policy-not-applicable',
      'seller-zone-missing',
      'allowed',
    ]);
    // Only the three seller-basis queries asked for certificates and zones.
    expect(zoneRequests).toEqual([[allowedQ.sellerId, noZoneQ.sellerId, lateAllowedQ.sellerId]]);
    expect(r.ok && r.value[1]!.inputs).toEqual(allowedQ);
  });

  it('asks the zones once for distinct sellers, decides duplicates alike and sellers by their own zone', async () => {
    const a = query();
    const twin = query({ sellerId: a.sellerId });
    const b = query();
    world.zonesOf.set(b.sellerId, { zone: null, addressZone: null });
    const r = await facade.evaluateClaims(system(), [a, twin, b]);
    expect(zoneRequests).toEqual([[a.sellerId, b.sellerId]]);
    expect(r.ok && r.value.map((d) => d.reason)).toEqual([
      'allowed',
      'allowed',
      'seller-zone-missing',
    ]);
  });

  it('makes no certificate or zone call when nothing needs a seller basis', async () => {
    world.rows = [{ basis: 'NOT_APPLICABLE' }];
    await facade.evaluateClaims(anonymous(), [query(), query()]);
    expect(calls).toEqual({ policies: 1, certificates: 0, zones: 0 });
    calls.policies = 0;
    const invalid = await facade.evaluateClaims(anonymous(), [null as never, 'x' as never]);
    expect(invalid.ok && invalid.value.every((d) => d.reason === 'input-invalid')).toBe(true);
    expect(calls).toEqual({ policies: 0, certificates: 0, zones: 0 });
  });

  it.each([
    [
      'the certificate read throws',
      (): void => {
        world.failCertificates = true;
      },
    ],
    [
      'the zone read throws',
      (): void => {
        world.failZones = true;
      },
    ],
    [
      'the certificate read is misaligned',
      (): void => {
        world.misalignedCertificates = true;
      },
    ],
  ] as const)('fails the batch closed when %s', async (_n, arrange) => {
    arrange();
    const r = await facade.evaluateClaims(anonymous(), [query(), query()]);
    expect(r.ok && r.value.map((d) => [d.allowed, d.reason])).toEqual([
      [false, 'unavailable'],
      [false, 'unavailable'],
    ]);
  });

  it('fails the batch closed when policy answers carry another type than requested (a reordered read)', async () => {
    world.shuffledAnswers = true;
    const r = await facade.evaluateClaims(anonymous(), [query(), query()]);
    expect(r.ok && r.value.every((d) => !d.allowed && d.reason === 'unavailable')).toBe(true);
  });

  it('fails closed when a certificate answer carries another seller than requested', async () => {
    world.wrongSellerCertificates = true;
    const r = await facade.evaluateClaims(anonymous(), [query()]);
    expect(r.ok && r.value[0]).toEqual(
      expect.objectContaining({ allowed: false, reason: 'unavailable' }),
    );
  });

  it('fails closed when a certificate answer carries another type than requested', async () => {
    world.wrongTypeCertificates = true;
    const r = await facade.evaluateClaims(anonymous(), [query()]);
    expect(r.ok && r.value[0]).toEqual(
      expect.objectContaining({ allowed: false, reason: 'unavailable' }),
    );
  });

  it('asks the policy read per valid query in order: the union of all paths, deduplicated, with handling', async () => {
    const [root, a, b] = [ids.next<'Category'>(), ids.next<'Category'>(), ids.next<'Category'>()];
    const multi = query({
      handling: 'REPACKED',
      platformCategoryPaths: [
        [root, a],
        [root, b],
      ],
    });
    const single = query();
    await facade.evaluateClaims(anonymous(), [null as never, multi, single]);
    expect(policyRequests).toHaveLength(2);
    expect(policyRequests[0]).toEqual({
      typeCode: fx.type,
      categoryIds: [root, a, b],
      handling: 'REPACKED',
    });
    expect(policyRequests[1]).toEqual({
      typeCode: fx.type,
      categoryIds: single.platformCategoryPaths[0],
      handling: 'SEALED_ORIGINAL',
    });
  });

  it('bounds the category paths: 50 paths and depth 12 pass, 51 and 13 do not', async () => {
    const path = (n: number): Id<'Category'>[] =>
      Array.from({ length: n }, () => ids.next<'Category'>());
    const reasons = async (over: Partial<ClaimQuery>): Promise<string> => {
      const r = await facade.evaluateClaims(anonymous(), [query(over)]);
      return r.ok ? r.value[0]!.reason : 'refused';
    };
    expect(
      await reasons({ platformCategoryPaths: Array.from({ length: 50 }, () => path(1)) }),
    ).toBe('allowed');
    expect(await reasons({ platformCategoryPaths: [path(12)] })).toBe('allowed');
    expect(
      await reasons({ platformCategoryPaths: Array.from({ length: 51 }, () => path(1)) }),
    ).toBe('input-invalid');
    expect(await reasons({ platformCategoryPaths: [path(13)] })).toBe('input-invalid');
    expect(await reasons({ platformCategoryPaths: ['x'] as never })).toBe('input-invalid');
    expect(await reasons({ platformCategoryPaths: [['not-an-id']] as never })).toBe(
      'input-invalid',
    );
  });

  it('keeps a SELLER_OR_MANUFACTURER policy on the seller path until the manufacturer step lands', async () => {
    world.rows = [{ basis: 'SELLER_OR_MANUFACTURER' }];
    world.certificate = null;
    const r = await facade.evaluateClaims(anonymous(), [query()]);
    expect(r.ok && r.value[0]).toEqual(
      expect.objectContaining({ allowed: false, reason: 'no-valid-seller-certificate' }),
    );
  });

  it.each([
    ['an unknown zone name', 'Mars/Olympus'],
    ['an empty zone', ''],
    ['an offset', '+10:00'],
    ['an ISO date-time with an offset', '2026-01-01T00:00:00+05:00'],
    ['an ISO date-time in Z', '2026-01-01T00:00Z'],
    ['a non-string', 42],
  ] as const)(
    'denies with seller-zone-missing for %s on a certificate with no expiry',
    async (_n, bad) => {
      world.certificate = {
        ...approved('2027-01-31'),
        approved: { ...approved('2027-01-31').approved!, requiresExpiry: false, expiryDate: null },
      };
      world.zones = { zone: bad as never, addressZone: bad as never };
      const r = await facade.evaluateClaims(anonymous(), [query()]);
      expect(r.ok && r.value[0]).toEqual(
        expect.objectContaining({ allowed: false, reason: 'seller-zone-missing' }),
      );
    },
  );

  it('answers input-invalid, with null inputs, for a throwing getter and a revoked proxy', async () => {
    const thrower = {
      get sellerId(): never {
        throw new Error('boom');
      },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const r = await facade.evaluateClaims(anonymous(), [thrower, revoked.proxy, query()] as never);
    expect(r.ok && r.value.map((d) => [d.reason, d.inputs === null])).toEqual([
      ['input-invalid', true],
      ['input-invalid', true],
      ['allowed', false],
    ]);
  });

  it('refuses a query with no platform category path', async () => {
    const r = await facade.evaluateClaims(anonymous(), [query({ platformCategoryPaths: [] })]);
    expect(r.ok && r.value[0]).toEqual(
      expect.objectContaining({ reason: 'input-invalid', inputs: null }),
    );
  });

  it('resolves the strictest of all matching rows and reports the policy revision', async () => {
    world.rows = [
      { basis: 'SELLER_REQUIRED' },
      { basis: 'NOT_APPLICABLE' },
      { basis: 'SELLER_OR_MANUFACTURER' },
    ];
    const strict = await facade.evaluateClaims(anonymous(), [query()]);
    expect(strict.ok && strict.value[0]).toEqual(
      expect.objectContaining({
        reason: 'policy-not-applicable',
        policyRevisionId: POLICY_REVISION,
      }),
    );
    // The default is used only when no row matches: a lenient row never beats a stricter default.
    world.type = { publishedRevisionId: ids.next(), defaultBasis: 'NOT_APPLICABLE' };
    world.rows = [{ basis: 'SELLER_REQUIRED' }];
    const eased = await facade.evaluateClaims(anonymous(), [query()]);
    expect(eased.ok && eased.value[0]).toEqual(
      expect.objectContaining({ allowed: true, policyRevisionId: POLICY_REVISION }),
    );
    world.rows = [];
    const dflt = await facade.evaluateClaims(anonymous(), [query()]);
    expect(dflt.ok && dflt.value[0]).toEqual(
      expect.objectContaining({ reason: 'policy-not-applicable', policyRevisionId: null }),
    );
  });

  it.each(['draft', 'in-review', 'changes-needed', 'declined', 'expired', 'revoked'] as const)(
    'denies a certificate with status %s',
    async (status) => {
      world.certificate = { ...approved('2027-01-31'), status };
      const r = await facade.evaluateClaims(anonymous(), [query()]);
      expect(r.ok && r.value[0]!.allowed).toBe(false);
    },
  );

  it('allows a closed-to-new issuer, denies an unresolvable zone, and never caches', async () => {
    world.certificate = approved('2027-01-31', 'closed-to-new');
    const q = query();
    const first = await facade.evaluateClaims(anonymous(), [q]);
    expect(first.ok && first.value[0]!.allowed).toBe(true);
    world.zones = { zone: 'Not/AZone', addressZone: fx.zone };
    const bad = await facade.evaluateClaims(anonymous(), [q]);
    expect(bad.ok && bad.value[0]).toEqual(
      expect.objectContaining({ allowed: false, reason: 'seller-zone-missing' }),
    );
    world.zones = { zone: fx.zone, addressZone: fx.zone };
    world.certificate = null;
    const none = await facade.evaluateClaims(anonymous(), [q]);
    expect(none.ok && none.value[0]!.allowed).toBe(false);
    expect(calls.policies).toBe(3);
  });

  it('gives every decision of a batch one evaluation instant', async () => {
    const r = await facade.evaluateClaims(anonymous(), [query(), null as never, query()]);
    expect(r.ok && new Set(r.value.map((d) => d.evaluatedAt.toString())).size).toBe(1);
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
