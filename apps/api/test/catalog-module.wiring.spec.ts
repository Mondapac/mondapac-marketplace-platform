import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import type { ClaimTextMatcher } from '../src/modules/catalog/application/ports/claim-text-matcher';
import { CertificationClaimTextMatcher } from '../src/modules/catalog/infrastructure/certification-claim-text-matcher';
import { CATALOGUE_APPLIER_PERMISSIONS } from '../src/modules/catalog/catalog.module';
import { createTestApp } from './support/test-app';

// The catalog module as the real application wires it (ADR-0031 decision 3): the claim-text
// matcher resolves to the binding over the certification facade; the placeholder is gone.
describe('catalog module wiring', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    ({ app } = await createTestApp());
  });
  afterAll(async () => {
    await app.close();
  });

  it('binds the claim-text matcher to the certification facade', () => {
    const matcher = app.get<ClaimTextMatcher>(CLAIM_TEXT_MATCHER, { strict: false });
    expect(matcher).toBeInstanceOf(CertificationClaimTextMatcher);
  });

  // Hassan L2: the approving admin needs every key the action's route needs, not only the first.
  it('registers each approval kind with every key of its route', () => {
    expect(Object.fromEntries(CATALOGUE_APPLIER_PERMISSIONS)).toEqual({
      'catalog.category-discard': ['catalog.category-tree.edit'],
      'catalog.category-restructure': ['catalog.category-tree.restructure'],
      'catalog.category-products-move': [
        'catalog.category-tree.restructure',
        'catalog.product.approve',
      ],
      'catalog.attribute-discard': ['catalog.attribute.edit'],
      'catalog.attribute-restructure': ['catalog.attribute.restructure'],
      'catalog.feature-set-create': ['catalog.attribute.edit'],
    });
  });
});
