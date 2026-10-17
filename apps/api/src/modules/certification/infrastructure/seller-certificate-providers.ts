import type { FactoryProvider, Provider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import { USE_CASE_GATE, type UseCaseGate } from '../../../platform/authz';
import { CLOCK } from '../../../platform/clock/clock.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import { OUTBOX_WRITER } from '../../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { OBJECT_STORE, type ObjectStore } from '../../../platform/storage/object-store';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { OwnCertificateDependencies } from '../application/own/own-certificate.shared';
import {
  CERTIFICATE_TYPE_CATALOG,
  type CertificateTypeCatalog,
} from '../application/ports/certificate-type-catalog';
import type { SellerZonesSource } from '../application/ports/claim-facts.ports';
import {
  CERTIFICATE_FIELD_CIPHER,
  DOCUMENT_INTAKE,
  DOCUMENT_VAULT,
  type CertificateFieldCipher,
  type DocumentIntake,
  type DocumentVault,
} from '../application/ports/document-ports';
import {
  RATE_COUNTER_KEYS,
  RATE_COUNTER_REPOSITORY,
  type RateCounterKeys,
  type RateCounterRepository,
} from '../application/ports/rate-counters';
import {
  SELLER_CERTIFICATE_REPOSITORY,
  type SellerCertificateRepository,
} from '../application/ports/seller-certificate.repository';
import { SELLER_ZONES_SOURCE } from '../application/ports/tokens';
import { OwnCertificateCreate } from '../application/use-cases/own-certificate-create.use-case';
import { OwnCertificateDeleteDraft } from '../application/use-cases/own-certificate-delete-draft.use-case';
import { OwnCertificateDocumentRead } from '../application/use-cases/own-certificate-document-read.use-case';
import { OwnCertificateOptions } from '../application/use-cases/own-certificate-options.use-case';
import { OwnCertificateRead } from '../application/use-cases/own-certificate-read.use-case';
import { OwnCertificateRemoveDocument } from '../application/use-cases/own-certificate-remove-document.use-case';
import { OwnCertificateSaveDraft } from '../application/use-cases/own-certificate-save-draft.use-case';
import { OwnCertificateSubmit } from '../application/use-cases/own-certificate-submit.use-case';
import { OwnCertificateUploadDocument } from '../application/use-cases/own-certificate-upload-document.use-case';
import { OwnCertificateWithdraw } from '../application/use-cases/own-certificate-withdraw.use-case';
import { OwnCertificatesList } from '../application/use-cases/own-certificates-list.use-case';
import {
  CERTIFICATE_INDEX_KEYS,
  type CertificateIndexKeys,
} from '../application/ports/review.ports';
import { HmacCertificateIndexKeys } from './hmac-index-keys';
import { HmacRateCounterKeys, localCertificationSecret } from './hmac-rate-counter-keys';
import { ObjectStoreDocumentVault } from './object-store-document-vault';
import { PrismaCertificateTypeCatalog } from './prisma-certificate-type-catalog';
import { PrismaRateCounterRepository } from './prisma-rate-counter.repository';
import { PrismaSellerCertificateRepository } from './prisma-seller-certificate.repository';
import { SharpDocumentIntake } from './sharp-document-intake';
import { SubjectKeyCertificateFieldCipher } from './subject-key-certificate-field-cipher';

/** Bytes of draft files one seller may hold (certification design 5.1): 200 MiB. */
export const DRAFT_QUOTA_BYTES = 200 * 1024 * 1024;

const CERTIFICATION_SECRET = Symbol('CERTIFICATION_STACK_SECRET');
const OWN_CERTIFICATE_DEPENDENCIES = Symbol('CERTIFICATION_OWN_CERTIFICATE_DEPENDENCIES');

const ownCertificateUseCases = [
  OwnCertificateCreate,
  OwnCertificateSaveDraft,
  OwnCertificateDeleteDraft,
  OwnCertificateUploadDocument,
  OwnCertificateRemoveDocument,
  OwnCertificateSubmit,
  OwnCertificateWithdraw,
  OwnCertificatesList,
  OwnCertificateRead,
  OwnCertificateDocumentRead,
  OwnCertificateOptions,
] as const;

/** One use case of the seller side: the gate and the shared dependencies. */
const useCaseProviders: readonly FactoryProvider[] = ownCertificateUseCases.map(
  (type): FactoryProvider => ({
    provide: type,
    inject: [USE_CASE_GATE, OWN_CERTIFICATE_DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: OwnCertificateDependencies) => new type(gate, deps),
  }),
);

/**
 * The seller side of a certificate (certification design 3, 7; slices 3 to 5, simplified): the
 * stores, the file intake and vault, the field cipher, the rate counters and the use cases that
 * share them. The stack secret is the local stand-in that refuses production (K1).
 */
export const sellerCertificateProviders: readonly Provider[] = [
  {
    provide: SELLER_CERTIFICATE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerCertificateRepository =>
      new PrismaSellerCertificateRepository(prisma),
  },
  {
    provide: CERTIFICATE_TYPE_CATALOG,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CertificateTypeCatalog =>
      new PrismaCertificateTypeCatalog(prisma),
  },
  {
    provide: RATE_COUNTER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RateCounterRepository =>
      new PrismaRateCounterRepository(prisma),
  },
  {
    provide: CERTIFICATION_SECRET,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): Uint8Array => localCertificationSecret(config),
  },
  {
    provide: RATE_COUNTER_KEYS,
    inject: [CERTIFICATION_SECRET],
    useFactory: (secret: Uint8Array): RateCounterKeys => new HmacRateCounterKeys(secret),
  },
  {
    provide: CERTIFICATE_INDEX_KEYS,
    inject: [CERTIFICATION_SECRET],
    useFactory: (secret: Uint8Array): CertificateIndexKeys => new HmacCertificateIndexKeys(secret),
  },
  { provide: DOCUMENT_INTAKE, useFactory: (): DocumentIntake => new SharpDocumentIntake() },
  {
    provide: DOCUMENT_VAULT,
    inject: [OBJECT_STORE, SUBJECT_KEY_SERVICE],
    useFactory: (store: ObjectStore, keys: SubjectKeyService): DocumentVault =>
      new ObjectStoreDocumentVault(store, keys),
  },
  {
    provide: CERTIFICATE_FIELD_CIPHER,
    inject: [SUBJECT_KEY_SERVICE],
    useFactory: (keys: SubjectKeyService): CertificateFieldCipher =>
      new SubjectKeyCertificateFieldCipher(keys),
  },
  {
    provide: OWN_CERTIFICATE_DEPENDENCIES,
    inject: [
      UNIT_OF_WORK,
      SELLER_CERTIFICATE_REPOSITORY,
      CERTIFICATE_TYPE_CATALOG,
      DOCUMENT_VAULT,
      DOCUMENT_INTAKE,
      CERTIFICATE_FIELD_CIPHER,
      RATE_COUNTER_REPOSITORY,
      RATE_COUNTER_KEYS,
      CERTIFICATE_INDEX_KEYS,
      SELLER_ZONES_SOURCE,
      OUTBOX_WRITER,
      CLOCK,
      ID_GENERATOR,
    ],
    useFactory: (
      unitOfWork: UnitOfWork,
      certificates: SellerCertificateRepository,
      types: CertificateTypeCatalog,
      vault: DocumentVault,
      intake: DocumentIntake,
      cipher: CertificateFieldCipher,
      counters: RateCounterRepository,
      counterKeys: RateCounterKeys,
      indexKeys: CertificateIndexKeys,
      zones: SellerZonesSource,
      outbox: OutboxWriter,
      clock: Clock,
      ids: IdGenerator,
    ): OwnCertificateDependencies => ({
      unitOfWork,
      certificates,
      types,
      vault,
      intake,
      cipher,
      counters,
      counterKeys,
      indexKeys,
      zones,
      outbox,
      clock,
      ids,
      draftQuotaBytes: DRAFT_QUOTA_BYTES,
    }),
  },
  ...useCaseProviders,
];
