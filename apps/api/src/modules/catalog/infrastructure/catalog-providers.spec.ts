import type { ClassProvider } from '@nestjs/common';
import { CLAIM_TEXT_MATCHER } from '../application/ports/claim-text-matcher';
import { catalogProviders } from './catalog-providers';
import { UnavailableClaimTextMatcher } from './placeholders/unavailable-claim-text-matcher';

// The production wiring of the claim-text matcher (ADR-0031 decisions 2 and 2a): exactly one
// binding, by class, to the fail-closed placeholder, until the binding PR replaces it.
describe('catalogProviders', () => {
  it('binds the claim-text matcher once, by class, to the placeholder', () => {
    const bound = catalogProviders.filter(
      (provider) => 'provide' in provider && provider.provide === CLAIM_TEXT_MATCHER,
    );
    expect(bound).toHaveLength(1);
    const [provider] = bound as ClassProvider[];
    expect(provider?.useClass).toBe(UnavailableClaimTextMatcher);
    // Nothing but `useClass`: no factory, value or alias that could choose another answer.
    expect(Object.keys(provider ?? {}).sort()).toEqual(['provide', 'useClass']);
  });
});
