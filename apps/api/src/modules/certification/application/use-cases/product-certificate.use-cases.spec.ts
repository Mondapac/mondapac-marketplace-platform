import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryOutbox } from '../../../../../test/support/certification-fakes';
import { FakeCatalogReferences } from '../../../../../test/support/certification-claim-policy-fakes';
import { RecordingAudit } from '../../../../../test/support/certification-review-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE,
  CERTIFICATION_PRODUCT_CERTIFICATE_EDIT,
  CERTIFICATION_PRODUCT_CERTIFICATE_VIEW,
} from '../../contracts/permissions';
import type { ProductCertificationDependencies } from '../product/product-certification.shared';
import { ProductCertificateApprove } from './product-certificate-approve.use-case';
import { ProductCertificateCreate } from './product-certificate-create.use-case';
import { ProductCertificateRead } from './product-certificate-read.use-case';
import { ProductCertificateReject } from './product-certificate-reject.use-case';
import { ProductCertificateReviewRead } from './product-certificate-review-read.use-case';
import { ProductCertificateSaveDraft } from './product-certificate-save-draft.use-case';
import { ProductCertificateSubmit } from './product-certificate-submit.use-case';
import { ProductCertificatesList } from './product-certificates-list.use-case';

// The manufacturer certificate use cases without a database (certification design 3.4, 7.1, 7.2;
// slice 14), on both Market fixtures: the access rules (protected edit and approve keys, the view
// key), the refusals that come before any read (acting-as, the population, malformed input), and
// that no store is touched then. The flow over the real tables is in
// test/db/certification-product-certification.db-spec.ts; the routes in
// test/certification-product-certificates.e2e.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-18T00:00:00Z');
const ID = '0192b3c4-0000-7000-8000-000000000001';

describe('manufacturer certificate access declarations', () => {
  it('needs the protected edit key to record, save and submit; the protected approve key to decide and read numbers; the view key to read', () => {
    for (const type of [
      ProductCertificateCreate,
      ProductCertificateSaveDraft,
      ProductCertificateSubmit,
    ]) {
      expect(type.access.rule).toEqual({
        kind: 'permissions',
        allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_EDIT.key],
      });
    }
    for (const type of [
      ProductCertificateApprove,
      ProductCertificateReject,
      ProductCertificateReviewRead,
    ]) {
      expect(type.access.rule).toEqual({
        kind: 'permissions',
        allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE.key],
      });
    }
    for (const type of [ProductCertificateRead, ProductCertificatesList]) {
      expect(type.access.rule).toEqual({
        kind: 'permissions',
        allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_VIEW.key],
      });
    }
    expect(CERTIFICATION_PRODUCT_CERTIFICATE_EDIT.protected).toBe(true);
    expect(CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE.protected).toBe(true);
    expect(CERTIFICATION_PRODUCT_CERTIFICATE_VIEW.protected).toBe(false);
  });
});

describe.each(['AU', 'ZZ'] as const)('manufacturer certificate use cases in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const touched: string[] = [];
  const untouchable = <T extends object>(name: string): T =>
    new Proxy({} as T, {
      get: (_t, key) => () => {
        touched.push(`${name}.${String(key)}`);
        return Promise.reject(new Error(`${name} must not be used`));
      },
    });

  const deps = (): ProductCertificationDependencies => {
    const clock = new FixedClock(T0);
    return {
      unitOfWork: untouchable<UnitOfWork>('unitOfWork'),
      products: untouchable('products'),
      registry: untouchable('registry'),
      catalog: new FakeCatalogReferences(),
      cipher: untouchable('cipher'),
      reviewPolicies: untouchable('reviewPolicies'),
      audit: new RecordingAudit(),
      outbox: new MemoryOutbox(),
      clock,
      ids: new SequenceIdGenerator(clock),
      marketZone: () => null,
    };
  };

  const adminContext = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ID as Id<'Account'>,
        sessionId: ID as Id<'Session'>,
        sellerId: null,
      }),
    );
  const sellerContext = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ID as Id<'Account'>,
        sessionId: ID as Id<'Session'>,
        sellerId: ID as Id<'Seller'>,
      }),
    );

  beforeEach(() => {
    touched.length = 0;
  });

  const writes = (d: ProductCertificationDependencies) =>
    [
      [new ProductCertificateCreate(gate, d), { typeId: ID }],
      [new ProductCertificateSaveDraft(gate, d), { certificateId: ID, version: 1, draft: {} }],
      [new ProductCertificateSubmit(gate, d), { certificateId: ID, version: 1 }],
      [new ProductCertificateApprove(gate, d), { certificateId: ID, revisionId: ID, version: 1 }],
      [
        new ProductCertificateReject(gate, d),
        { certificateId: ID, revisionId: ID, version: 1, reasonCode: 'x' },
      ],
      [new ProductCertificateReviewRead(gate, d), { certificateId: ID }],
    ] as const;

  // The acting-as refusal of every write is `reviewerOf` (write: true), tested in
  // review/review.shared.spec.ts: a minted actor cannot carry acting-as outside identity.
  it('refuses a seller on every route, before any store', async () => {
    const d = deps();
    for (const [useCase, input] of writes(d)) {
      const result = await (
        useCase as { execute: (c: CallContext, i: unknown) => Promise<unknown> }
      ).execute(sellerContext(), input);
      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    }
    for (const useCase of [
      new ProductCertificateRead(gate, d),
      new ProductCertificatesList(gate, d),
    ]) {
      expect(await useCase.execute(sellerContext(), { certificateId: ID })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    expect(touched).toEqual([]);
  });

  it.each([
    ['create', () => new ProductCertificateCreate(gate, deps()), { typeId: 'x' }, 'typeId'],
    [
      'save-draft',
      () => new ProductCertificateSaveDraft(gate, deps()),
      { certificateId: ID, version: 0, draft: {} },
      'version',
    ],
    [
      'submit',
      () => new ProductCertificateSubmit(gate, deps()),
      { certificateId: 'nope', version: 1 },
      'certificateId',
    ],
    [
      'approve',
      () => new ProductCertificateApprove(gate, deps()),
      { certificateId: ID, revisionId: 'nope', version: 1 },
      'revisionId',
    ],
    [
      'approve with a reason',
      () => new ProductCertificateApprove(gate, deps()),
      { certificateId: ID, revisionId: ID, version: 1, reasonCode: 'x' },
      'reasonCode',
    ],
    [
      'reject without a reason',
      () => new ProductCertificateReject(gate, deps()),
      { certificateId: ID, revisionId: ID, version: 1 },
      'reasonCode',
    ],
    [
      'list with an unknown status',
      () => new ProductCertificatesList(gate, deps()),
      { status: 'lost' },
      'status',
    ],
    [
      'list with a page too long',
      () => new ProductCertificatesList(gate, deps()),
      { limit: 101 },
      'limit',
    ],
  ] as const)(
    'refuses malformed input (%s) before any store',
    async (_label, make, input, path) => {
      const result = (await (
        make() as unknown as { execute: (c: CallContext, i: unknown) => Promise<unknown> }
      ).execute(adminContext(), input)) as { ok: boolean; error?: { fields?: { path: string }[] } };
      expect(result.ok).toBe(false);
      expect(result.error?.fields?.[0]?.path).toBe(path);
      expect(touched).toEqual([]);
    },
  );

  it('refuses a draft with an unknown coverage key: the product revision never comes from the client (M3)', async () => {
    const result = await new ProductCertificateSaveDraft(gate, deps()).execute(adminContext(), {
      certificateId: ID,
      version: 1,
      draft: {
        manufacturerName: 'Maker',
        issuerId: null,
        issueDate: null,
        expiryDate: null,
        coverage: [{ productId: ID, productRevisionId: ID }],
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'coverage[0]', code: 'unknown-key' }] },
    });
    expect(touched).toEqual([]);
  });

  it('fails closed without a usable Market zone: submit and decisions are unavailable', async () => {
    const d = deps();
    expect(
      await new ProductCertificateSubmit(gate, d).execute(adminContext(), {
        certificateId: ID,
        version: 1,
      }),
    ).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    expect(
      await new ProductCertificateApprove(gate, d).execute(adminContext(), {
        certificateId: ID,
        revisionId: ID,
        version: 1,
      }),
    ).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    expect(touched).toEqual([]);
  });
});
