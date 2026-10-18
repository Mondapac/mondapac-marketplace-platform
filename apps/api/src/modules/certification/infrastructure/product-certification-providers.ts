import type { FactoryProvider, Provider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import { AUDIT_WRITER, type AuditWriter } from '../../../platform/audit/audit-writer';
import { USE_CASE_GATE, type UseCaseGate } from '../../../platform/authz';
import { CLOCK } from '../../../platform/clock/clock.module';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
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
import { isUsableZone } from '../domain/validity';
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
] as const;

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
    provide: PRODUCT_CERTIFICATION_DEPENDENCIES,
    inject: [
      UNIT_OF_WORK,
      PRODUCT_CERTIFICATION_REPOSITORY,
      CERTIFICATION_REGISTRY_REPOSITORY,
      CATALOG_REFERENCES,
      PRODUCT_CERTIFICATE_CIPHER,
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
      reviewPolicies,
      audit,
      outbox,
      clock,
      ids,
      marketZone: (market) => {
        try {
          const zone = markets.get(market.marketId).timezone;
          return isUsableZone(zone) ? zone : null;
        } catch {
          return null;
        }
      },
    }),
  },
  ...productCertificationUseCases.map((type): FactoryProvider => ({
    provide: type,
    inject: [USE_CASE_GATE, PRODUCT_CERTIFICATION_DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: ProductCertificationDependencies) => new type(gate, deps),
  })),
];
