import type { FactoryProvider, Provider } from '@nestjs/common';
import type { Clock, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import { AUDIT_WRITER, type AuditWriter } from '../../../platform/audit/audit-writer';
import { USE_CASE_GATE, type UseCaseGate } from '../../../platform/authz';
import { CLOCK } from '../../../platform/clock/clock.module';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { OBJECT_STORE, type ObjectStore } from '../../../platform/storage/object-store';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_REFERENCES,
  type CatalogReferences,
} from '../application/ports/catalog-references';
import {
  DOCUMENT_INTAKE,
  PLATFORM_DOCUMENT_VAULT,
  type DocumentIntake,
  type PlatformDocumentVault,
} from '../application/ports/document-ports';
import {
  PRODUCT_CERTIFICATE_CIPHER,
  type ProductCertificateCipher,
} from '../application/ports/product-certificate-cipher';
import {
  PRODUCT_CERTIFICATION_REPOSITORY,
  type ProductCertificationRepository,
} from '../application/ports/product-certification.repository';
import {
  CERTIFICATION_REGISTRY_REPOSITORY,
  type CertificationRegistryRepository,
} from '../application/ports/registry.repository';
import {
  REVIEW_POLICY_PROVIDER,
  type ReviewPolicyProvider,
} from '../application/ports/review.ports';
import type { ProductCertificationDependencies } from '../application/product/product-certification.shared';
import { ProductCertificateApprove } from '../application/use-cases/product-certificate-approve.use-case';
import { ProductCertificateCreate } from '../application/use-cases/product-certificate-create.use-case';
import { ProductCertificateRead } from '../application/use-cases/product-certificate-read.use-case';
import { ProductCertificateReject } from '../application/use-cases/product-certificate-reject.use-case';
import { ProductCertificateReviewRead } from '../application/use-cases/product-certificate-review-read.use-case';
import { ProductCertificateSaveDraft } from '../application/use-cases/product-certificate-save-draft.use-case';
import { ProductCertificateSubmit } from '../application/use-cases/product-certificate-submit.use-case';
import { ProductCertificatesList } from '../application/use-cases/product-certificates-list.use-case';
import { ProductCertificateHistoryRead } from '../application/use-cases/product-certificate-history-read.use-case';
import { ProductCertificateReinstate } from '../application/use-cases/product-certificate-reinstate.use-case';
import { ProductCertificateRevoke } from '../application/use-cases/product-certificate-revoke.use-case';
import { ProductCertificateSuspend } from '../application/use-cases/product-certificate-suspend.use-case';
import { ProductCertificateUploadDocument } from '../application/use-cases/product-certificate-upload-document.use-case';
import { ProductCertificateRemoveDocument } from '../application/use-cases/product-certificate-remove-document.use-case';
import { ProductCertificateRecordCheck } from '../application/use-cases/product-certificate-record-check.use-case';
import { ExpireProductCertificates } from '../application/use-cases/expire-product-certificates.use-case';
import {
  EXPIRY_POLICY_PROVIDER,
  type ExpiryPolicyProvider,
} from '../application/ports/expiry.repository';
import type { TimeZoneId } from '../domain/claim-types';
import { isUsableZone } from '../domain/validity';
import {
  ObjectStoreDocumentVault,
  PlatformSubjectDocumentVault,
} from './object-store-document-vault';
import { PrismaProductCertificationRepository } from './prisma-product-certification.repository';
import { SubjectKeyProductCertificateCipher } from './subject-key-product-certificate-cipher';
import { SubjectKeyRegistryCipher } from './subject-key-registry-cipher';

const PRODUCT_CERTIFICATION_DEPENDENCIES = Symbol(
  'CERTIFICATION_PRODUCT_CERTIFICATION_DEPENDENCIES',
);

/** The admin use cases behind the manufacturer certificate pages (slice 14). */
export const productCertificationUseCases = [
  ProductCertificatesList,
  ProductCertificateRead,
  ProductCertificateReviewRead,
  ProductCertificateCreate,
  ProductCertificateSaveDraft,
  ProductCertificateSubmit,
  ProductCertificateApprove,
  ProductCertificateReject,
  ProductCertificateSuspend,
  ProductCertificateRevoke,
  ProductCertificateReinstate,
  ProductCertificateHistoryRead,
  ProductCertificateUploadDocument,
  ProductCertificateRemoveDocument,
  ProductCertificateRecordCheck,
] as const;

/** The Market's configured zone when usable (2.4 rule 3), else null (fail closed). */
function marketZoneOf(markets: MarketRegistry): (market: MarketContext) => TimeZoneId | null {
  return (market) => {
    try {
      const zone = markets.get(market.marketId).timezone;
      return isUsableZone(zone) ? zone : null;
    } catch {
      return null;
    }
  };
}

/**
 * The manufacturer certificate (certification design 3.4, 7.1, 7.2; ADR-0012 d3; slice 14): the
 * store, the cipher of the number under the Market's platform subject, `catalog`'s
 * `CatalogReferences` binding and the admin use cases. The Market zone measures the expiry.
 */
export const productCertificationProviders: readonly Provider[] = [
  {
    provide: PRODUCT_CERTIFICATION_REPOSITORY,
    inject: [PrismaService, ID_GENERATOR],
    useFactory: (prisma: PrismaService, ids: IdGenerator): ProductCertificationRepository =>
      new PrismaProductCertificationRepository(prisma, ids),
  },
  {
    provide: PRODUCT_CERTIFICATE_CIPHER,
    inject: [
      SUBJECT_KEY_SERVICE,
      UNIT_OF_WORK,
      CERTIFICATION_REGISTRY_REPOSITORY,
      ID_GENERATOR,
      CLOCK,
    ],
    useFactory: (
      keys: SubjectKeyService,
      unitOfWork: UnitOfWork,
      registry: CertificationRegistryRepository,
      ids: IdGenerator,
      clock: Clock,
    ): ProductCertificateCipher =>
      new SubjectKeyProductCertificateCipher(
        keys,
        new SubjectKeyRegistryCipher(keys, unitOfWork, registry, ids, clock),
      ),
  },
  {
    // The admin's files under the Market's platform subject (slice 15 part 2).
    provide: PLATFORM_DOCUMENT_VAULT,
    inject: [
      OBJECT_STORE,
      SUBJECT_KEY_SERVICE,
      UNIT_OF_WORK,
      CERTIFICATION_REGISTRY_REPOSITORY,
      ID_GENERATOR,
      CLOCK,
    ],
    useFactory: (
      store: ObjectStore,
      keys: SubjectKeyService,
      unitOfWork: UnitOfWork,
      registry: CertificationRegistryRepository,
      ids: IdGenerator,
      clock: Clock,
    ): PlatformDocumentVault =>
      new PlatformSubjectDocumentVault(
        new ObjectStoreDocumentVault(store, keys),
        new SubjectKeyRegistryCipher(keys, unitOfWork, registry, ids, clock),
      ),
  },
  {
    provide: PRODUCT_CERTIFICATION_DEPENDENCIES,
    inject: [
      UNIT_OF_WORK,
      PRODUCT_CERTIFICATION_REPOSITORY,
      CERTIFICATION_REGISTRY_REPOSITORY,
      CATALOG_REFERENCES,
      PRODUCT_CERTIFICATE_CIPHER,
      DOCUMENT_INTAKE,
      PLATFORM_DOCUMENT_VAULT,
      REVIEW_POLICY_PROVIDER,
      AUDIT_WRITER,
      OUTBOX_WRITER,
      CLOCK,
      ID_GENERATOR,
      MarketRegistry,
    ],
    useFactory: (
      unitOfWork: UnitOfWork,
      products: ProductCertificationRepository,
      registry: CertificationRegistryRepository,
      catalog: CatalogReferences,
      cipher: ProductCertificateCipher,
      intake: DocumentIntake,
      documents: PlatformDocumentVault,
      reviewPolicies: ReviewPolicyProvider,
      audit: AuditWriter,
      outbox: OutboxWriter,
      clock: Clock,
      ids: IdGenerator,
      markets: MarketRegistry,
    ): ProductCertificationDependencies => ({
      unitOfWork,
      products,
      registry,
      catalog,
      cipher,
      intake,
      documents,
      reviewPolicies,
      audit,
      outbox,
      clock,
      ids,
      marketZone: marketZoneOf(markets),
    }),
  },
  {
    // The manufacturer half of the expiry and warnings job (design 8.6; slice 15).
    provide: ExpireProductCertificates,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      PRODUCT_CERTIFICATION_REPOSITORY,
      EXPIRY_POLICY_PROVIDER,
      AUDIT_WRITER,
      OUTBOX_WRITER,
      CLOCK,
      ID_GENERATOR,
      MarketRegistry,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: UnitOfWork,
      products: ProductCertificationRepository,
      policies: ExpiryPolicyProvider,
      audit: AuditWriter,
      outbox: OutboxWriter,
      clock: Clock,
      ids: IdGenerator,
      markets: MarketRegistry,
    ) =>
      new ExpireProductCertificates(gate, {
        unitOfWork,
        products,
        policies,
        audit,
        outbox,
        clock,
        ids,
        marketZone: marketZoneOf(markets),
      }),
  },
  ...productCertificationUseCases.map((type): FactoryProvider => ({
    provide: type,
    inject: [USE_CASE_GATE, PRODUCT_CERTIFICATION_DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: ProductCertificationDependencies) => new type(gate, deps),
  })),
];
