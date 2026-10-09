import type { TestingModuleBuilder } from '@nestjs/testing';
import { IDENTITY_MARKET_POLICY } from '../../src/modules/identity/application/ports/identity-market-policy';
import type { IdentityMarketPolicy } from '../../src/modules/identity/application/ports/identity-market-policy';
import { MarketConfigIdentityPolicy } from '../../src/modules/identity/infrastructure/market-config-identity-policy';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';

/**
 * A Market that configures custom-role limits (identity design 2.3; slice 10). The real Market
 * files carry none yet, so the role editor's create fails closed there; tests that exercise the
 * editor on the real stack override the policy with this.
 */
export function withRoleLimit(builder: TestingModuleBuilder, limit: number): TestingModuleBuilder {
  return builder.overrideProvider(IDENTITY_MARKET_POLICY).useFactory({
    factory: (markets: MarketRegistry): IdentityMarketPolicy =>
      Object.assign(
        Object.create(new MarketConfigIdentityPolicy(markets)) as IdentityMarketPolicy,
        {
          customRoleLimit: () => limit,
        },
      ),
    inject: [MarketRegistry],
  });
}
