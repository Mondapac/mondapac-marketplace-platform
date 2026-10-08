import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { Id } from '@mondapac/shared-kernel';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  CERTIFICATION_FACADE,
  type CertificationFacade,
  type CertificationTypeCode,
  type ClaimQuery,
} from '../src/modules/certification';
import { createTestApp } from './support/test-app';

// The certification module as the real application wires it: the facade resolves, and
// `evaluateClaims` rests on the fail-closed claim-facts reader (ADR-0031), so every query of a
// valid batch answers `unavailable` and no tag is ever allowed, in both Market fixtures. The
// reads of the published types need the database and are covered by the db-specs.

const id = <T extends string>(n: number): Id<T> =>
  `0192b3c4-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<T>;

describe.each(['AU', 'ZZ'] as const)('certification module wiring, Market %s', (marketCode) => {
  let app: NestExpressApplication;
  let facade: CertificationFacade;
  beforeAll(async () => {
    ({ app } = await createTestApp());
    facade = app.get<CertificationFacade>(CERTIFICATION_FACADE, { strict: false });
  });
  afterAll(async () => {
    await app.close();
  });

  const query: ClaimQuery = {
    sellerId: id<'Seller'>(1),
    productId: id<'Product'>(2),
    productRevisionId: id<'ProductRevision'>(3),
    variantId: null,
    typeCode: 'halal' as CertificationTypeCode,
    handling: 'SEALED_ORIGINAL',
    attestationRecorded: true,
    platformCategoryPaths: [[id<'Category'>(4)]],
  };

  it.each(['anonymous', 'system'] as const)(
    'answers every query unavailable for a %s caller, never allowed',
    async (actor) => {
      const context = testCallContext(testMarketContext(marketCode, 'default'), actor);
      const result = await facade.evaluateClaims(context, [query, query]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.map((d) => d.reason)).toEqual(['unavailable', 'unavailable']);
      expect(result.value.some((d) => d.allowed)).toBe(false);
    },
  );
});
