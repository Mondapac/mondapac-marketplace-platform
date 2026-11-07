import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryTypeCatalog } from '../../../../../test/support/certification-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CERTIFICATION_PRODUCT_CERTIFICATE_EDIT } from '../../contracts/permissions';
import { ProductCertificateFormOptions } from './product-certificate-form-options.use-case';

// The manufacturer certificate form's options without a database, on both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const ID = '0192b3c4-0000-7000-8000-000000000001';
const unitOfWork = {
  run: (_market: MarketContext, work: () => Promise<unknown>) => work(),
} as unknown as UnitOfWork;

const typeId = (n: number) => `0192b3c4-0000-7000-8000-0000000c${n}00` as Id<'CertificationType'>;
const issuerId = (n: number) => `0192b3c4-0000-7000-8000-0000000d${n}00` as Id<'Issuer'>;

function settings(
  n: number,
  code: string,
  mode: 'THIRD_PARTY_DOCUMENT' | 'SELF_DECLARATION',
  names: Record<string, string>,
) {
  return {
    typeId: typeId(n),
    code,
    status: 'active' as const,
    revisionId: `0192b3c4-0000-7000-8000-0000000e${n}00` as Id<'CertificationTypeRevision'>,
    verificationMode: mode,
    requiresIssuerRegistry: true,
    requiresDocument: true,
    requiresExpiry: n % 2 === 0,
    names,
  };
}

describe('product-certificates.form-options access declaration', () => {
  it('needs the edit key', () => {
    expect(ProductCertificateFormOptions.access).toEqual({
      name: 'certification.product-certificate-form-options',
      rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_EDIT.key] },
    });
  });
});

describe.each(['AU', 'ZZ'] as const)('product-certificates.form-options in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const other: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const catalog = new MemoryTypeCatalog();
  const useCase = new ProductCertificateFormOptions(gate, { unitOfWork, types: catalog });

  const contextOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ID as Id<'Account'>,
        sessionId: ID as Id<'Session'>,
        sellerId: population === 'seller' ? (ID as Id<'Seller'>) : null,
      }),
    );

  beforeEach(() => {
    catalog.types.clear();
    catalog.issuers.clear();
    catalog.addType(
      market,
      settings(1, 'halal-manufacturer', 'THIRD_PARTY_DOCUMENT', { en: 'Halal' }),
    );
    catalog.addType(market, settings(2, 'self-declared', 'SELF_DECLARATION', { en: 'Self' }));
    catalog.addType(market, settings(4, 'no-english', 'THIRD_PARTY_DOCUMENT', { 'ja-JP': 'J' }));
    catalog.addType(other, settings(3, 'other-market', 'THIRD_PARTY_DOCUMENT', { en: 'Other' }));
    for (const [n, m, type, state] of [
      [1, market, 1, 'active'],
      [2, market, 1, 'derecognised'],
      [3, market, 2, 'active'],
      [4, other, 3, 'active'],
    ] as const) {
      catalog.addIssuer(m, {
        id: issuerId(n),
        typeId: typeId(type),
        displayName: `Issuer ${n}`,
        state,
      });
    }
  });

  it('refuses a seller before any read', async () => {
    catalog.unavailable = true;
    expect(await useCase.execute(contextOf('seller'), {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    catalog.unavailable = false;
  });

  it('lists the active third-party types of the Market with their active issuers', async () => {
    const result = await useCase.execute(contextOf('admin'), {});
    expect(result).toEqual({
      ok: true,
      value: {
        types: [
          {
            typeId: typeId(1),
            code: 'halal-manufacturer',
            name: 'Halal',
            requiresDocument: true,
            requiresExpiry: false,
            requiresIssuerRegistry: true,
            issuers: [{ issuerId: issuerId(1), displayName: 'Issuer 1' }],
          },
          {
            typeId: typeId(4),
            code: 'no-english',
            name: null,
            requiresDocument: true,
            requiresExpiry: true,
            requiresIssuerRegistry: true,
            issuers: [],
          },
        ],
      },
    });
  });
});
