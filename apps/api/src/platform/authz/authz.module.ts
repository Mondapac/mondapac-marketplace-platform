import { Global, Module } from '@nestjs/common';
import { MarketRegistry } from '../market-config/market-registry';
import { UseCaseGate } from './use-case-gate';

/**
 * The access-rule mechanism (identity design 5.2; platform-foundations design 6). Global, like
 * the other platform runtime modules: every module's use cases take the {@link UseCaseGate}.
 *
 * Until identity slice 2 no `AuthorisationCheck` exists, so the gate is built without one and
 * refuses every authenticated actor with `access.unavailable` (no authenticated actor can be
 * minted before then either). Slice 2 binds identity's implementation through
 * `AUTHORISATION_CHECK`, required at start in both roles; `platform/` ships no fallback.
 */
@Global()
@Module({
  providers: [
    {
      provide: UseCaseGate,
      inject: [MarketRegistry],
      useFactory: (markets: MarketRegistry) => new UseCaseGate(markets, null),
    },
  ],
  exports: [UseCaseGate],
})
export class AuthzModule {}
