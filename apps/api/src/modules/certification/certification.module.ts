import { Module, type FactoryProvider } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { registerPermissions } from '../../platform/authz';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { registerEvents } from '../../platform/events/event-catalogue';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { IdentityModule } from '../identity';
import { SellersModule } from '../sellers';
import {
  APPROVED_SELLER_ZONES,
  type ApprovedSellerZonesReader,
} from '../sellers/contracts/approved-seller-zones.contract';
import {
  CERTIFIED_CATEGORIES_READER,
  CLAIM_FACTS_READER,
  PUBLISHED_TYPES_READER,
  SELLER_ZONES_SOURCE,
} from './application/ports/tokens';
import type { ClaimFactsReader, SellerZonesSource } from './application/ports/claim-facts.ports';
import type { CertifiedCategoriesReader } from './application/ports/certified-categories.reader';
import type { PublishedTypesReader } from './application/ports/published-types.reader';
import { CertifiedCategories } from './application/use-cases/certified-categories.use-case';
import { CertificationTypesSystem } from './application/use-cases/certification-types-system.use-case';
import { CertificationTypes } from './application/use-cases/certification-types.use-case';
import { EvaluateClaimsSystem } from './application/use-cases/evaluate-claims-system.use-case';
import { EvaluateClaims } from './application/use-cases/evaluate-claims.use-case';
import { ClaimTermList } from './application/use-cases/claim-term-list.use-case';
import { MatchClaimTermsSystem } from './application/use-cases/match-claim-terms-system.use-case';
import { MatchClaimTerms } from './application/use-cases/match-claim-terms.use-case';
import { CERTIFICATION_FACADE } from './contracts/certification.facade';
import { isUsableZone } from './domain/validity';
import { manufacturerBasisEnabledIn } from './infrastructure/market-config-expiry-policy';
import { claimFactsReaderProvider } from './infrastructure/claim-facts-reader.provider';
import { certifiedCategoriesReaderProvider } from './infrastructure/certified-categories-reader.provider';
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
import { CERTIFICATION_AUDIT_ACTIONS } from './domain/audit';
import { CERTIFICATION_EVENTS } from './domain/events';
import { SellerCertificateOverview } from './application/use-cases/seller-certificate-overview.use-case';
import { SendDecisionMail } from './application/use-cases/send-decision-mail.use-case';
import { reviewProviders } from './infrastructure/review-providers';
import { AdminCertificateReviewController } from './presentation/admin-certificate-review.controller';
import { decisionMailSubscriptions } from './presentation/subscribers/decision-mail.subscriptions';
import { SendIssuerRequestMail } from './application/use-cases/send-issuer-request-mail.use-case';
import { issuerRequestProviders } from './infrastructure/issuer-request-providers';
import { AdminIssuerRequestController } from './presentation/admin-issuer-request.controller';
import { OwnIssuerRequestController } from './presentation/own-issuer-request.controller';
import { issuerRequestMailSubscriptions } from './presentation/subscribers/issuer-request-mail.subscriptions';
import { sellerCertificateProviders } from './infrastructure/seller-certificate-providers';
import { OwnCertificateController } from './presentation/own-certificate.controller';
import { seedCertificationTypesJob } from './presentation/jobs/seed-certification-types.job';
import { ExpireSellerCertificates } from './application/use-cases/expire-seller-certificates.use-case';
import { ExpireProductCertificates } from './application/use-cases/expire-product-certificates.use-case';
import { SendExpiryMail } from './application/use-cases/send-expiry-mail.use-case';
import { expiryProviders } from './infrastructure/expiry-providers';
import { expiryAndWarningsJob } from './presentation/jobs/expiry-and-warnings.job';
import { expiryMailSubscriptions } from './presentation/subscribers/expiry-mail.subscriptions';
import { SendDerecognitionMail } from './application/use-cases/send-derecognition-mail.use-case';
import { registryProviders } from './infrastructure/registry-providers';
import { claimPolicyProviders } from './infrastructure/claim-policy-providers';
import { productCertificationProviders } from './infrastructure/product-certification-providers';
import { AdminClaimPolicyController } from './presentation/admin-claim-policy.controller';
import { AdminProductCertificateController } from './presentation/admin-product-certificate.controller';
import { AdminCertificationTypeController } from './presentation/admin-certification-type.controller';
import { AdminIssuerRegistryController } from './presentation/admin-issuer-registry.controller';
import { derecognitionMailSubscriptions } from './presentation/subscribers/derecognition-mail.subscriptions';

/** The use cases that only read the published types: the gate and the reader. */
const readerUseCases = [
  CertificationTypes,
  CertificationTypesSystem,
  ClaimTermList,
  MatchClaimTerms,
  MatchClaimTermsSystem,
].map((type): FactoryProvider => ({
  provide: type,
  inject: [USE_CASE_GATE, PUBLISHED_TYPES_READER],
  useFactory: (gate: UseCaseGate, reader: PublishedTypesReader) => new type(gate, reader),
}));

/**
 * `evaluateClaims` and its pair: the gate, the claim facts, the seller zones, the clock and the
 * Market's configured zone (manufacturer expiry, design 2.4 rule 3; an unusable zone is none).
 */
const evaluateUseCases = [EvaluateClaims, EvaluateClaimsSystem].map((type): FactoryProvider => ({
  provide: type,
  inject: [USE_CASE_GATE, CLAIM_FACTS_READER, SELLER_ZONES_SOURCE, CLOCK, MarketRegistry],
  useFactory: (
    gate: UseCaseGate,
    facts: ClaimFactsReader,
    zones: SellerZonesSource,
    clock: Clock,
    markets: MarketRegistry,
  ) =>
    new type(
      gate,
      facts,
      zones,
      clock,
      (context) => {
        const zone = markets.get(context.market.marketId).timezone;
        return isUsableZone(zone) ? zone : null;
      },
      (context) => manufacturerBasisEnabledIn(markets, context.market.marketId),
    ),
}));

/**
 * The certification bounded context (docs/design/domain/certification.md; ADR-0013), filled
 * slice by slice. Today it binds the read side of the facade: the published types reader (each
 * call in a read-only unit of its own) behind `matchClaimTerms` and `certificationTypes`, and
 * `evaluateClaims` over the claim-facts reader on the module's own raw read port (ADR-0030):
 * the seller basis, the policy rows and the type default, and the manufacturer basis (slices 13
 * and 14: approved manufacturer certificates through S3, only where the Market switch is on).
 */
@Module({
  imports: [PersistenceModule, SellersModule, IdentityModule],
  controllers: [
    OwnCertificateController,
    AdminCertificateReviewController,
    OwnIssuerRequestController,
    AdminIssuerRequestController,
    AdminCertificationTypeController,
    AdminIssuerRegistryController,
    AdminClaimPolicyController,
    AdminProductCertificateController,
  ],
  providers: [
    PersistenceModule.outboxWriterFor('certification'),
    registerEvents('certification', CERTIFICATION_EVENTS),
    registerPermissions('certification', CERTIFICATION_PERMISSIONS),
    PersistenceModule.auditWriterFor('certification'),
    registerAuditActions('certification', CERTIFICATION_AUDIT_ACTIONS),
    registerSubscriptionsFrom(
      'certification',
      [SendDecisionMail, SendIssuerRequestMail, SendExpiryMail, SendDerecognitionMail],
      (
        mail: SendDecisionMail,
        issuerRequestMail: SendIssuerRequestMail,
        expiryMail: SendExpiryMail,
        derecognitionMail: SendDerecognitionMail,
      ) => [
        ...decisionMailSubscriptions(mail),
        ...issuerRequestMailSubscriptions(issuerRequestMail),
        ...expiryMailSubscriptions(expiryMail),
        ...derecognitionMailSubscriptions(derecognitionMail),
      ],
    ),
    ...sellerCertificateProviders,
    ...reviewProviders,
    ...issuerRequestProviders,
    ...expiryProviders,
    ...registryProviders,
    ...claimPolicyProviders,
    ...productCertificationProviders,
    PersistenceModule.rawReadFor('certification'),
    publishedTypesReaderProvider,
    certifiedCategoriesReaderProvider,
    {
      provide: CertifiedCategories,
      inject: [USE_CASE_GATE, CERTIFIED_CATEGORIES_READER],
      useFactory: (gate: UseCaseGate, reader: CertifiedCategoriesReader) =>
        new CertifiedCategories(gate, reader),
    },
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
    registerJobsFrom(
      'certification',
      [SeedCertificationTypes, ExpireSellerCertificates, ExpireProductCertificates],
      (
        seed: SeedCertificationTypes,
        expire: ExpireSellerCertificates,
        expireProducts: ExpireProductCertificates,
      ) => [seedCertificationTypesJob(seed), expiryAndWarningsJob(expire, expireProducts)],
    ),
    ...readerUseCases,
    ...evaluateUseCases,
    {
      provide: CERTIFICATION_FACADE,
      inject: [
        EvaluateClaims,
        EvaluateClaimsSystem,
        ClaimTermList,
        MatchClaimTerms,
        MatchClaimTermsSystem,
        CertificationTypes,
        CertificationTypesSystem,
        SellerCertificateOverview,
        CertifiedCategories,
      ],
      useFactory: (
        evaluateClaims: EvaluateClaims,
        evaluateClaimsSystem: EvaluateClaimsSystem,
        claimTermList: ClaimTermList,
        matchClaimTerms: MatchClaimTerms,
        matchClaimTermsSystem: MatchClaimTermsSystem,
        certificationTypes: CertificationTypes,
        certificationTypesSystem: CertificationTypesSystem,
        sellerCertificateOverview: SellerCertificateOverview,
        certifiedCategories: CertifiedCategories,
      ) =>
        new CertificationFacadeImplementation({
          evaluateClaims,
          evaluateClaimsSystem,
          claimTermList,
          matchClaimTerms,
          matchClaimTermsSystem,
          certificationTypes,
          certificationTypesSystem,
          sellerCertificateOverview,
          certifiedCategories,
        }),
    },
  ],
  exports: [CERTIFICATION_FACADE],
})
export class CertificationModule {}
