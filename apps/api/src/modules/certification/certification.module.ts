import { Module, type FactoryProvider } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { SellersModule } from '../sellers';
import {
  APPROVED_SELLER_ZONES,
  type ApprovedSellerZonesReader,
} from '../sellers/contracts/approved-seller-zones.contract';
import {
  CLAIM_FACTS_READER,
  PUBLISHED_TYPES_READER,
  SELLER_ZONES_SOURCE,
} from './application/ports/tokens';
import type { ClaimFactsReader, SellerZonesSource } from './application/ports/claim-facts.ports';
import type { PublishedTypesReader } from './application/ports/published-types.reader';
import { CertificationTypesSystem } from './application/use-cases/certification-types-system.use-case';
import { CertificationTypes } from './application/use-cases/certification-types.use-case';
import { EvaluateClaimsSystem } from './application/use-cases/evaluate-claims-system.use-case';
import { EvaluateClaims } from './application/use-cases/evaluate-claims.use-case';
import { MatchClaimTermsSystem } from './application/use-cases/match-claim-terms-system.use-case';
import { MatchClaimTerms } from './application/use-cases/match-claim-terms.use-case';
import { CERTIFICATION_FACADE } from './contracts/certification.facade';
import { FailClosedClaimFactsReader } from './infrastructure/fail-closed-claim-facts.reader';
import { publishedTypesReaderProvider } from './infrastructure/published-types-reader.provider';
import { SellersZonesSource } from './infrastructure/sellers-zones.source';
import { CertificationFacadeImplementation } from './presentation/certification.facade';
import type { Clock } from '@mondapac/shared-kernel';

/** The use cases that only read the published types: the gate and the reader. */
const readerUseCases = [
  CertificationTypes,
  CertificationTypesSystem,
  MatchClaimTerms,
  MatchClaimTermsSystem,
].map((type): FactoryProvider => ({
  provide: type,
  inject: [USE_CASE_GATE, PUBLISHED_TYPES_READER],
  useFactory: (gate: UseCaseGate, reader: PublishedTypesReader) => new type(gate, reader),
}));

/** `evaluateClaims` and its pair: the gate, the claim facts, the seller zones and the clock. */
const evaluateUseCases = [EvaluateClaims, EvaluateClaimsSystem].map((type): FactoryProvider => ({
  provide: type,
  inject: [USE_CASE_GATE, CLAIM_FACTS_READER, SELLER_ZONES_SOURCE, CLOCK],
  useFactory: (
    gate: UseCaseGate,
    facts: ClaimFactsReader,
    zones: SellerZonesSource,
    clock: Clock,
  ) => new type(gate, facts, zones, clock),
}));

/**
 * The certification bounded context (docs/design/domain/certification.md; ADR-0013), filled
 * slice by slice. Today it binds the read side of the facade: the published types reader (each
 * call in a read-only unit of its own) behind `matchClaimTerms` and `certificationTypes`, and
 * `evaluateClaims` over a fail-closed claim-facts reader (ADR-0031) until the raw read
 * statements and the policy tables exist, so it answers `unavailable` for every query.
 */
@Module({
  imports: [PersistenceModule, SellersModule],
  providers: [
    publishedTypesReaderProvider,
    { provide: CLAIM_FACTS_READER, useFactory: () => new FailClosedClaimFactsReader() },
    {
      provide: SELLER_ZONES_SOURCE,
      inject: [APPROVED_SELLER_ZONES],
      useFactory: (reader: ApprovedSellerZonesReader) => new SellersZonesSource(reader),
    },
    ...readerUseCases,
    ...evaluateUseCases,
    {
      provide: CERTIFICATION_FACADE,
      inject: [
        EvaluateClaims,
        EvaluateClaimsSystem,
        MatchClaimTerms,
        MatchClaimTermsSystem,
        CertificationTypes,
        CertificationTypesSystem,
      ],
      useFactory: (
        evaluateClaims: EvaluateClaims,
        evaluateClaimsSystem: EvaluateClaimsSystem,
        matchClaimTerms: MatchClaimTerms,
        matchClaimTermsSystem: MatchClaimTermsSystem,
        certificationTypes: CertificationTypes,
        certificationTypesSystem: CertificationTypesSystem,
      ) =>
        new CertificationFacadeImplementation({
          evaluateClaims,
          evaluateClaimsSystem,
          matchClaimTerms,
          matchClaimTermsSystem,
          certificationTypes,
          certificationTypesSystem,
        }),
    },
  ],
  exports: [CERTIFICATION_FACADE],
})
export class CertificationModule {}
