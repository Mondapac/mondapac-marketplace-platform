import { Module, type FactoryProvider } from '@nestjs/common';
import { registerPermissions } from '../../platform/authz';
import { registerEvents } from '../../platform/events/event-catalogue';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
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
import { claimFactsReaderProvider } from './infrastructure/claim-facts-reader.provider';
import { publishedTypesReaderProvider } from './infrastructure/published-types-reader.provider';
import { SellersZonesSource } from './infrastructure/sellers-zones.source';
import { CertificationFacadeImplementation } from './presentation/certification.facade';
import type { Clock, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import {
  CERTIFICATION_TYPE_REPOSITORY,
  type CertificationTypeRepository,
} from './application/ports/certification-type.repository';
import { CERTIFICATION_TYPE_SEED, type CertificationTypeSeed } from './application/ports/type-seed';
import { SeedCertificationTypes } from './application/use-cases/seed-certification-types.use-case';
import { certificationTypeRepositoryProvider } from './infrastructure/certification-type-repository.provider';
import { CheckedInTypeSeed } from './infrastructure/seed/checked-in-type-seed';
import { CERTIFICATION_PERMISSIONS } from './contracts/permissions';
import { CERTIFICATION_EVENTS } from './domain/events';
import { sellerCertificateProviders } from './infrastructure/seller-certificate-providers';
import { OwnCertificateController } from './presentation/own-certificate.controller';
import { seedCertificationTypesJob } from './presentation/jobs/seed-certification-types.job';

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
 * `evaluateClaims` over the claim-facts reader on the module's own raw read port (ADR-0030):
 * the seller basis and the type default; policy rows arrive with slice 13.
 */
@Module({
  imports: [PersistenceModule, SellersModule],
  controllers: [OwnCertificateController],
  providers: [
    PersistenceModule.outboxWriterFor('certification'),
    registerEvents('certification', CERTIFICATION_EVENTS),
    registerPermissions('certification', CERTIFICATION_PERMISSIONS),
    ...sellerCertificateProviders,
    PersistenceModule.rawReadFor('certification'),
    publishedTypesReaderProvider,
    claimFactsReaderProvider,
    {
      provide: SELLER_ZONES_SOURCE,
      inject: [APPROVED_SELLER_ZONES],
      useFactory: (reader: ApprovedSellerZonesReader) => new SellersZonesSource(reader),
    },
    certificationTypeRepositoryProvider,
    {
      provide: CERTIFICATION_TYPE_SEED,
      useFactory: (): CertificationTypeSeed => new CheckedInTypeSeed(),
    },
    {
      provide: SeedCertificationTypes,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        CERTIFICATION_TYPE_REPOSITORY,
        CERTIFICATION_TYPE_SEED,
        MarketRegistry,
        CLOCK,
        ID_GENERATOR,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        types: CertificationTypeRepository,
        seed: CertificationTypeSeed,
        markets: MarketRegistry,
        clock: Clock,
        ids: IdGenerator,
      ) =>
        new SeedCertificationTypes(gate, {
          unitOfWork,
          types,
          seed,
          supportedLocales: (market: MarketContext) =>
            markets.get(market.marketId).supportedLocales,
          clock,
          ids,
        }),
    },
    registerJobsFrom('certification', [SeedCertificationTypes], (seed: SeedCertificationTypes) => [
      seedCertificationTypesJob(seed),
    ]),
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
