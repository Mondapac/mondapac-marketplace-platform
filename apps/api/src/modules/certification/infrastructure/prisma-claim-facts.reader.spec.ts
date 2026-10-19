import { err } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import type {
  RawReadPort,
  RawReadRow,
} from '../../../platform/persistence/raw-reads/raw-read-port';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../platform/unit-of-work/unit-of-work';
import type { CertificationTypeCode } from '../domain/claim-types';
import { MAX_POLICY_ROWS } from '../domain/claim-policy';
import { PrismaClaimFactsReader } from './prisma-claim-facts.reader';

type Basis = RawReadRow<'certification.seller-basis'>;
type TypeRow = RawReadRow<'certification.type-and-policy'>;
type Manufacturer = RawReadRow<'certification.manufacturer-basis'>;

const id = (n: number): string => `0192b3c4-0000-7000-8000-${String(n).padStart(12, '0')}`;
const code = (value: string) => value as CertificationTypeCode;

interface Run {
  readonly market: MarketContext;
  readonly options: UnitOfWorkOptions | undefined;
}

const unitOf = (runs: Run[]): UnitOfWork => ({
  async run<T, E>(
    market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options?: UnitOfWorkOptions,
  ) {
    runs.push({ market, options });
    return work();
  },
  runOnce: () => Promise.reject(new Error('not used')),
});

const portOf = (rows: readonly unknown[], calls: unknown[] = []): RawReadPort =>
  ({
    rawRead: (_market: MarketContext, statement: string, params: unknown) => {
      calls.push({ statement, params });
      return Promise.resolve(rows);
    },
  }) as unknown as RawReadPort;

const basis = (overrides: Partial<Basis> = {}): Basis => ({
  ord: 1,
  typeId: id(1),
  certificationId: id(2),
  status: 'approved',
  submissionId: id(3),
  issuerId: null,
  expiryDate: '2027-06-30',
  typeRevisionId: id(4),
  decisionOutcome: 'approved',
  decisionActorKind: 'admin',
  approvedZone: 'Australia/Brisbane',
  hasExpiryBoundary: true,
  requiresExpiry: true,
  issuerState: null,
  verificationMode: 'THIRD_PARTY_DOCUMENT',
  issuerName: null,
  verifiedWithIssuer: false,
  ...overrides,
});

const typeRow = (overrides: Partial<TypeRow> = {}): TypeRow => ({
  typeId: id(1),
  code: 'halal',
  verificationMode: 'THIRD_PARTY_DOCUMENT',
  typeRevisionId: id(4),
  defaultBasis: 'SELLER_REQUIRED',
  policyRevisionId: null,
  rowSelectorKind: null,
  rowCategoryId: null,
  rowHandling: null,
  rowBasis: null,
  ...overrides,
});

/** One S2 row carrying a policy row of the published revision `id(50)`. */
const policyRow = (
  selector: { categoryId: string } | { handling: string },
  basis: string,
  overrides: Partial<TypeRow> = {},
): TypeRow =>
  typeRow({
    policyRevisionId: id(50),
    rowSelectorKind: 'categoryId' in selector ? 'platform-category' : 'handling',
    rowCategoryId: 'categoryId' in selector ? selector.categoryId : null,
    rowHandling: 'handling' in selector ? selector.handling : null,
    rowBasis: basis,
    ...overrides,
  });

const pair = (seller: number, type = 'halal') => ({
  sellerId: id(seller) as Id<'Seller'>,
  typeCode: code(type),
});

describe.each(['AU', 'ZZ'] as const)('PrismaClaimFactsReader, Market %s', (marketCode) => {
  const market = testMarketContext(marketCode, 'default');
  const reader = (rows: readonly unknown[], runs: Run[] = [], calls: unknown[] = []) =>
    new PrismaClaimFactsReader(unitOf(runs), portOf(rows, calls));
  const policy = (typeCode: string) =>
    ({ typeCode: code(typeCode), categoryIds: [], handling: 'FRESH' }) as never;

  it('opens one read-only unit of the Market per call and sends the distinct codes once', async () => {
    const runs: Run[] = [];
    const calls: unknown[] = [];
    await reader([typeRow()], runs, calls).typesAndPolicies(market, [
      policy('halal'),
      policy('halal'),
    ]);
    expect(runs).toEqual([{ market, options: { readOnly: true } }]);
    expect(calls).toEqual([
      { statement: 'certification.type-and-policy', params: { typeCodes: ['halal'] } },
    ]);
  });

  it('answers by request key, not by row order, with policy null', async () => {
    const answers = await reader([
      typeRow({ code: 'zed', defaultBasis: 'NOT_APPLICABLE' }),
      typeRow({ code: 'halal' }),
    ]).typesAndPolicies(market, [policy('halal'), policy('zed'), policy('gone')]);
    expect(answers.map((a) => [a.typeCode, a.type?.defaultBasis ?? null, a.policy])).toEqual([
      ['halal', 'SELLER_REQUIRED', null],
      ['zed', 'NOT_APPLICABLE', null],
      ['gone', null, null],
    ]);
  });

  it.each([
    ['a NULL published revision', typeRow({ typeRevisionId: null, defaultBasis: null })],
    ['a revision without a basis', typeRow({ defaultBasis: null })],
    ['an invalid default basis', typeRow({ defaultBasis: 'SELLER_OR_MANUFACTURER' })],
    ['a revision id that is not an id', typeRow({ typeRevisionId: 'not-an-id' })],
    ['a type nobody asked for', typeRow({ code: 'other' })],
    ['an invalid verification mode', typeRow({ verificationMode: 'BOGUS' })],
    ['a policy row with an unknown basis', policyRow({ categoryId: id(60) }, 'SELLER')],
    [
      'SELLER_OR_MANUFACTURER on handling (M1)',
      policyRow({ handling: 'SEALED_ORIGINAL' }, 'SELLER_OR_MANUFACTURER'),
    ],
    ['an unknown handling', policyRow({ handling: 'FROZEN' }, 'SELLER_REQUIRED')],
    [
      'a row whose selector does not fit',
      policyRow({ handling: 'FRESH' }, 'SELLER_REQUIRED', { rowCategoryId: id(60) }),
    ],
    ['a category that is not an id', policyRow({ categoryId: 'nope' }, 'SELLER_REQUIRED')],
    [
      'a policy row without a published revision',
      policyRow({ categoryId: id(60) }, 'SELLER_REQUIRED', { policyRevisionId: null }),
    ],
  ])('rejects on %s', async (_name, row) => {
    await expect(reader([row]).typesAndPolicies(market, [policy('halal')])).rejects.toThrow();
  });

  it('picks the published rows matching the categories or the handling, per request', async () => {
    const r = reader([
      policyRow({ categoryId: id(60) }, 'SELLER_OR_MANUFACTURER'),
      policyRow({ categoryId: id(61) }, 'NOT_APPLICABLE'),
      policyRow({ handling: 'REPACKED' }, 'SELLER_REQUIRED'),
      typeRow({ typeId: id(2), code: 'zed' }),
    ]);
    const ask = (typeCode: string, categoryIds: string[], handling: string) =>
      ({ typeCode: code(typeCode), categoryIds, handling }) as never;
    const answers = await r.typesAndPolicies(market, [
      ask('halal', [id(60)], 'SEALED_ORIGINAL'),
      ask('halal', [id(60), id(61)], 'SEALED_ORIGINAL'),
      ask('halal', [id(62)], 'REPACKED'),
      ask('halal', [id(62)], 'FRESH'),
      ask('zed', [id(60)], 'REPACKED'),
    ]);
    expect(answers.map((a) => a.policy)).toEqual([
      { revisionId: id(50), matchedRows: [{ basis: 'SELLER_OR_MANUFACTURER' }] },
      {
        revisionId: id(50),
        matchedRows: [{ basis: 'SELLER_OR_MANUFACTURER' }, { basis: 'NOT_APPLICABLE' }],
      },
      { revisionId: id(50), matchedRows: [{ basis: 'SELLER_REQUIRED' }] },
      { revisionId: id(50), matchedRows: [] },
      null,
    ]);
    expect(answers[0]!.type).toEqual({
      publishedRevisionId: id(4),
      defaultBasis: 'SELLER_REQUIRED',
      verificationMode: 'THIRD_PARTY_DOCUMENT',
    });
  });

  it('answers a published revision without rows as a policy with no matched rows', async () => {
    const answers = await reader([typeRow({ policyRevisionId: id(50) })]).typesAndPolicies(market, [
      policy('halal'),
    ]);
    expect(answers[0]!.policy).toEqual({ revisionId: id(50), matchedRows: [] });
  });

  it.each([
    [
      'two rows on one selector',
      [
        policyRow({ categoryId: id(60) }, 'SELLER_REQUIRED'),
        policyRow({ categoryId: id(60) }, 'NOT_APPLICABLE'),
      ],
    ],
    [
      'a type row beside its policy rows',
      [policyRow({ categoryId: id(60) }, 'SELLER_REQUIRED'), typeRow()],
    ],
    [
      'a policy row of another type revision',
      [
        policyRow({ categoryId: id(60) }, 'SELLER_REQUIRED'),
        policyRow({ categoryId: id(61) }, 'SELLER_REQUIRED', { typeRevisionId: id(5) }),
      ],
    ],
    [
      'a policy row of another policy revision',
      [
        policyRow({ categoryId: id(60) }, 'SELLER_REQUIRED'),
        policyRow({ categoryId: id(61) }, 'SELLER_REQUIRED', { policyRevisionId: id(51) }),
      ],
    ],
  ])('rejects %s', async (_name, rows) => {
    await expect(reader(rows).typesAndPolicies(market, [policy('halal')])).rejects.toThrow();
  });

  it('accepts a revision of MAX_POLICY_ROWS rows and rejects one more (fail closed; data design 7.3)', async () => {
    const rowsOf = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        policyRow({ categoryId: id(1000 + i) }, 'NOT_APPLICABLE'),
      );
    const full = await reader(rowsOf(MAX_POLICY_ROWS)).typesAndPolicies(market, [policy('halal')]);
    expect(full[0]!.policy?.revisionId).toBe(id(50));
    await expect(
      reader(rowsOf(MAX_POLICY_ROWS + 1)).typesAndPolicies(market, [policy('halal')]),
    ).rejects.toThrow('more rows');
  });

  describe('productCertificates (S3)', () => {
    const triple = (product = 70, type = 'halal', variant: number | null = null) => ({
      typeCode: code(type),
      productId: id(product) as Id<'Product'>,
      productRevisionId: id(product + 1) as Id<'ProductRevision'>,
      variantId: variant === null ? null : (id(variant) as Id<'Variant'>),
    });
    const manufacturer = (overrides: Partial<Manufacturer> = {}): Manufacturer => ({
      ord: 1,
      typeCode: 'halal',
      productCertificationId: id(80),
      status: 'approved',
      revisionId: id(81),
      typeRevisionId: id(82),
      requiresExpiry: true,
      issuerId: id(83),
      expiryDate: '2027-06-30',
      decisionOutcome: 'approved',
      // As stored at approval: the end of 2027-06-30 in the Market zone, in UTC.
      expiryBoundaryAt: marketCode === 'AU' ? '2027-06-30 14:00:00+00' : '2027-06-30 15:00:00+00',
      issuerState: 'active',
      issuerName: 'Issuer One',
      productId: id(70),
      productRevisionId: id(71),
      variantId: null,
      verifiedWithIssuer: false,
      ...overrides,
    });

    it('sends the distinct triples in one read-only unit and one statement', async () => {
      const runs: Run[] = [];
      const calls: unknown[] = [];
      await reader([], runs, calls).productCertificates(market, [
        triple(70),
        triple(70, 'halal', 90),
        triple(70, 'kosher'),
      ]);
      expect(runs).toEqual([{ market, options: { readOnly: true } }]);
      expect(calls).toEqual([
        {
          statement: 'certification.manufacturer-basis',
          params: {
            productIds: [id(70), id(70)],
            productRevisionIds: [id(71), id(71)],
            typeCodes: ['halal', 'kosher'],
          },
        },
      ]);
    });

    it('folds the coverage rows of one certificate and answers every request of the triple', async () => {
      const answers = await reader([
        manufacturer({ variantId: id(90) }),
        manufacturer({ variantId: id(91) }),
      ]).productCertificates(market, [triple(70, 'halal', 90), triple(70, 'halal', 92)]);
      expect(answers).toHaveLength(2);
      for (const answer of answers) {
        expect(answer.certificates).toHaveLength(1);
        const cert = answer.certificates[0]!;
        expect(cert.typeCode).toBe('halal');
        expect(cert.approved?.typeRevisionId).toBe(id(82));
        expect(cert.approved?.coverage.map((c) => c.variantId)).toEqual([id(90), id(91)]);
        expect(cert.approved?.boundaryAtApproval?.toString()).toBe(
          marketCode === 'AU' ? '2027-06-30T14:00:00Z' : '2027-06-30T15:00:00Z',
        );
      }
      expect(answers.map((a) => a.variantId)).toEqual([id(90), id(92)]);
    });

    it('keeps two types on one product apart (L2)', async () => {
      const answers = await reader([
        manufacturer({ ord: 2, typeCode: 'kosher', productCertificationId: id(84) }),
        manufacturer(),
      ]).productCertificates(market, [triple(70), triple(70, 'kosher')]);
      expect(answers.map((a) => a.certificates.map((c) => [c.typeCode, c.certificateId]))).toEqual([
        [['halal', id(80)]],
        [['kosher', id(84)]],
      ]);
    });

    it('answers no valid approval without an approved decision', async () => {
      const [answer] = await reader([
        manufacturer({ decisionOutcome: 'withdrawn' }),
      ]).productCertificates(market, [triple()]);
      expect(answer!.certificates[0]!.approved).toBeNull();
    });

    it('uses the boundary stored at approval as stored, never recomputed from the date (Hassan L1)', async () => {
      const [answer] = await reader([
        manufacturer({ expiryBoundaryAt: '2027-07-02 19:30:00.25+10' }),
      ]).productCertificates(market, [triple()]);
      expect(answer!.certificates[0]!.approved?.boundaryAtApproval?.toString()).toBe(
        '2027-07-02T09:30:00.25Z',
      );
      expect(answer!.certificates[0]!.approved?.expiryDate?.toString()).toBe('2027-06-30');
      await expect(
        reader([manufacturer({ expiryBoundaryAt: '2027-07-02T09:30:00Z' })]).productCertificates(
          market,
          [triple()],
        ),
      ).rejects.toThrow('stored instant');
    });

    it('drops the date of a required expiry without a stored boundary (expiry-missing)', async () => {
      const [answer] = await reader([manufacturer({ expiryBoundaryAt: null })]).productCertificates(
        market,
        [triple()],
      );
      expect(answer!.certificates[0]!.approved?.expiryDate).toBeNull();
      expect(answer!.certificates[0]!.approved?.boundaryAtApproval).toBeNull();
    });

    it.each([
      ['an unknown position', manufacturer({ ord: 9 })],
      ['a row for another product revision (M3)', manufacturer({ productRevisionId: id(99) })],
      ['a row for another type', manufacturer({ typeCode: 'kosher' })],
      ['a status other than approved', manufacturer({ status: 'suspended' })],
      ['an unreadable issuer state', manufacturer({ issuerState: 'gone' })],
      ['an empty issuer name', manufacturer({ issuerName: '' })],
      ['an id that is not an id', manufacturer({ revisionId: 'nope' })],
      ['a variant that is not an id', manufacturer({ variantId: 'nope' })],
    ])('rejects on %s', async (_label, row) => {
      await expect(reader([row]).productCertificates(market, [triple()])).rejects.toThrow();
    });

    it('rejects two versions of one certificate', async () => {
      await expect(
        reader([
          manufacturer({ variantId: id(90) }),
          manufacturer({ variantId: id(91), revisionId: id(85) }),
        ]).productCertificates(market, [triple()]),
      ).rejects.toThrow('two versions');
    });

    it('answers an empty request without a unit or a statement', async () => {
      const runs: Run[] = [];
      const calls: unknown[] = [];
      await expect(reader([], runs, calls).productCertificates(market, [])).resolves.toEqual([]);
      expect([runs, calls]).toEqual([[], []]);
    });
  });

  it('rejects on a repeated type row', async () => {
    await expect(
      reader([typeRow(), typeRow()]).typesAndPolicies(market, [policy('halal')]),
    ).rejects.toThrow(/repeated/);
  });

  it('rejects when the unit answers an error', async () => {
    const unit: UnitOfWork = {
      run: <T, E>() => Promise.resolve(err('boom') as unknown as Result<T, E>),
      runOnce: () => Promise.reject(new Error('not used')),
    };
    await expect(
      new PrismaClaimFactsReader(unit, portOf([])).sellerCertificates(market, [pair(9)]),
    ).rejects.toThrow('unit');
  });

  it('answers an empty request without a unit or a statement', async () => {
    const runs: Run[] = [];
    const calls: unknown[] = [];
    const r = reader([], runs, calls);
    await expect(r.typesAndPolicies(market, [])).resolves.toEqual([]);
    await expect(r.sellerCertificates(market, [])).resolves.toEqual([]);
    expect(runs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('sends distinct (seller, type) pairs zipped and answers every request, in order', async () => {
    const calls: unknown[] = [];
    const answers = await reader(
      [basis({ ord: 2, certificationId: id(8) })],
      [],
      calls,
    ).sellerCertificates(market, [pair(7), pair(9), pair(7)]);
    expect(calls).toEqual([
      {
        statement: 'certification.seller-basis',
        params: { sellerIds: [id(7), id(9)], typeCodes: ['halal', 'halal'] },
      },
    ]);
    expect(answers.map((a) => [a.sellerId, a.certificate?.certificateId ?? null])).toEqual([
      [id(7), null],
      [id(9), id(8)],
      [id(7), null],
    ]);
  });

  it('maps an approved decision to the approved submission view', async () => {
    const [answer] = await reader([
      basis({
        issuerId: id(5),
        issuerState: 'closed-to-new',
        issuerName: 'Registry Name',
        verifiedWithIssuer: true,
      }),
    ]).sellerCertificates(market, [pair(7)]);
    expect(answer!.certificate).toMatchObject({
      certificateId: id(2),
      status: 'approved',
      approved: {
        submissionId: id(3),
        typeRevisionId: id(4),
        requiresExpiry: true,
        zoneAtApproval: 'Australia/Brisbane',
        verificationMode: 'THIRD_PARTY_DOCUMENT',
        issuerId: id(5),
        issuerState: 'closed-to-new',
        issuerDisplayName: 'Registry Name',
        verifiedWithIssuer: true,
      },
    });
    expect(answer!.certificate!.approved!.expiryDate!.toString()).toBe('2027-06-30');
  });

  it.each([
    ['no decision row', basis({ decisionOutcome: null, approvedZone: null })],
    ['a withdrawn decision', basis({ decisionOutcome: 'withdrawn', approvedZone: null })],
    ['an approved outcome without a zone', basis({ approvedZone: null })],
    [
      'no approved pointer',
      basis({ submissionId: null, decisionOutcome: null, approvedZone: null }),
    ],
  ])('gives no approved submission for %s', async (_name, row) => {
    const [answer] = await reader([row]).sellerCertificates(market, [pair(7)]);
    expect(answer!.certificate!.approved).toBeNull();
  });

  it('drops the expiry date of a type that requires one when the decision has no boundary', async () => {
    const [needs] = await reader([basis({ hasExpiryBoundary: false })]).sellerCertificates(market, [
      pair(7),
    ]);
    expect(needs!.certificate!.approved).toMatchObject({ requiresExpiry: true, expiryDate: null });
    const [free] = await reader([
      basis({ hasExpiryBoundary: false, requiresExpiry: false }),
    ]).sellerCertificates(market, [pair(7)]);
    expect(free!.certificate!.approved!.expiryDate!.toString()).toBe('2027-06-30');
  });

  it.each([
    ['an unknown status', basis({ status: 'approvedish' })],
    ['two certificates for one pair', [basis(), basis()]],
    ['a position outside the request', basis({ ord: 3 })],
    ['an approved submission without its type revision', basis({ typeRevisionId: null })],
    ['an approved submission without the expiry rule', basis({ requiresExpiry: null })],
    ['an issuer without a readable state', basis({ issuerId: id(5), issuerState: null })],
    ['an issuer in an unknown state', basis({ issuerId: id(5), issuerState: 'maybe' })],
    [
      'an issuer without a name',
      basis({ issuerId: id(5), issuerState: 'active', issuerName: null }),
    ],
    [
      'an issuer with an empty name',
      basis({ issuerId: id(5), issuerState: 'active', issuerName: '' }),
    ],
    ['an unknown verification mode', basis({ verificationMode: 'TRUST_ME' })],
    ['an id that is not an id', basis({ certificationId: 'not-an-id' })],
    ['an approved decision made by the system', basis({ decisionActorKind: 'system' })],
    ['an approved decision made by the seller', basis({ decisionActorKind: 'seller' })],
    ['an approved decision without an actor', basis({ decisionActorKind: null })],
    ['a malformed expiry date', basis({ expiryDate: '30/06/2027' })],
  ])('rejects on %s', async (_name, rows) => {
    await expect(
      reader(Array.isArray(rows) ? rows : [rows]).sellerCertificates(market, [pair(7)]),
    ).rejects.toThrow();
  });
});
