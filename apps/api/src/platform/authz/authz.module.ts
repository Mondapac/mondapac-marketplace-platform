import { Global, Module } from '@nestjs/common';
import { MarketRegistry } from '../market-config/market-registry';
import { createUseCaseGate } from './use-case-gate';
import { USE_CASE_GATE } from './use-case-gate.token';

/**
 * The access-rule mechanism (identity design 5.2; platform-foundations design 6). Global, like
 * the other platform runtime modules: every module's use cases take the gate through
 * {@link USE_CASE_GATE}. This provider is the only place a running process builds a gate (M1).
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
      provide: USE_CASE_GATE,
      inject: [MarketRegistry],
      useFactory: (markets: MarketRegistry) => createUseCaseGate(markets, null),
    },
  ],
  exports: [USE_CASE_GATE],
})
export class AuthzModule {}
