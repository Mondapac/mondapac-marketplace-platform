import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { MarketRegistry } from '../market-config/market-registry';
import { AUTHORISATION_CHECK, type AuthorisationCheck } from './authorisation-check';
import { createUseCaseGate } from './use-case-gate';
import { USE_CASE_GATE } from './use-case-gate.token';

/**
 * The access-rule mechanism (identity design 5.2; platform-foundations design 6). Global, like
 * the other platform runtime modules: every module's use cases take the gate through
 * {@link USE_CASE_GATE}. This provider is the only place a running process builds a gate (M1).
 *
 * From identity slice 2 the gate is built with identity's `AuthorisationCheck`, required at
 * start in both roles (foundations 6.3 row 1): `app.module.ts` passes the module that provides
 * and exports {@link AUTHORISATION_CHECK} (identity's), so `platform/` imports no module
 * (ADR-0018 decision 4), and a graph without it fails boot with Nest's unknown-dependency
 * error. `platform/` ships no fallback.
 */
@Module({})
export class AuthzModule {
  static register(authorisationProvider: Type): DynamicModule {
    return {
      module: AuthzModule,
      global: true,
      imports: [authorisationProvider],
      providers: [
        {
          provide: USE_CASE_GATE,
          inject: [MarketRegistry, AUTHORISATION_CHECK],
          useFactory: (markets: MarketRegistry, authorisation: AuthorisationCheck) =>
            createUseCaseGate(markets, authorisation),
        },
      ],
      exports: [USE_CASE_GATE],
    };
  }
}
