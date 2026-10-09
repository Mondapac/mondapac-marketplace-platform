import type { FactoryProvider } from '@nestjs/common';
import { CLAIM_TEXT_MATCHER } from '../application/ports/claim-text-matcher';
import { CERTIFICATION_FACADE, type CertificationFacade } from '../../certification';
import { catalogProviders } from './catalog-providers';
import { CertificationClaimTextMatcher } from './certification-claim-text-matcher';

// The production wiring of the claim-text matcher (ADR-0031 decision 3): exactly one binding, to
// the real certification facade; the placeholder is gone.
describe('catalogProviders', () => {
  it('binds the claim-text matcher once, over the certification facade', () => {
    const bound = catalogProviders.filter(
      (provider) => 'provide' in provider && provider.provide === CLAIM_TEXT_MATCHER,
    );
    expect(bound).toHaveLength(1);
    const [provider] = bound as FactoryProvider<unknown>[];
    expect(provider?.inject).toEqual([CERTIFICATION_FACADE]);
    const facade = {} as CertificationFacade;
    expect(provider?.useFactory(facade)).toBeInstanceOf(CertificationClaimTextMatcher);
  });
});
