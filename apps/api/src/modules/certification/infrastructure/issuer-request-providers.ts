import type { FactoryProvider, Provider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import { AUDIT_WRITER, type AuditWriter } from '../../../platform/audit/audit-writer';
import { USE_CASE_GATE, type UseCaseGate } from '../../../platform/authz';
import { CLOCK } from '../../../platform/clock/clock.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { APP_CONFIG } from '../../../platform/config/config.module';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { MAIL_TRANSPORT, type MailTransport } from '../../../platform/mail/mail-transport';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { IssuerRequestDependencies } from '../application/issuer-requests/issuer-request.shared';
import {
  CERTIFICATE_TYPE_CATALOG,
  type CertificateTypeCatalog,
} from '../application/ports/certificate-type-catalog';
import type { SellerZonesSource } from '../application/ports/claim-facts.ports';
import {
  SELLER_OWNER_CONTACT,
  type SellerOwnerContact,
} from '../application/ports/decision-mail.ports';
import {
  CERTIFICATE_FIELD_CIPHER,
  DOCUMENT_INTAKE,
  DOCUMENT_VAULT,
  type CertificateFieldCipher,
  type DocumentIntake,
  type DocumentVault,
} from '../application/ports/document-ports';
import {
  ISSUER_REQUEST_REPOSITORY,
  type IssuerRequestRepository,
} from '../application/ports/issuer-request.repository';
import {
  RATE_COUNTER_KEYS,
  RATE_COUNTER_REPOSITORY,
  type RateCounterKeys,
  type RateCounterRepository,
} from '../application/ports/rate-counters';
import {
  CERTIFICATION_MAIL_POLICY,
  REVIEW_POLICY_PROVIDER,
  REVIEW_SELLER_SOURCE,
  type CertificationMailPolicy,
  type ReviewPolicyProvider,
  type ReviewSellerSource,
} from '../application/ports/review.ports';
import { SELLER_ZONES_SOURCE } from '../application/ports/tokens';
import { IssuerRequestAnswer } from '../application/use-cases/issuer-request-answer.use-case';
import { IssuerRequestDocumentRead } from '../application/use-cases/issuer-request-document-read.use-case';
import { IssuerRequestRead } from '../application/use-cases/issuer-request-read.use-case';
import { IssuerRequestsQueue } from '../application/use-cases/issuer-requests-queue.use-case';
import { OwnIssuerRequestCreate } from '../application/use-cases/own-issuer-request-create.use-case';
import {
  SendIssuerRequestMail,
  type IssuerRequestMailDependencies,
} from '../application/use-cases/send-issuer-request-mail.use-case';
import { PrismaIssuerRequestRepository } from './prisma-issuer-request.repository';

const ISSUER_REQUEST_DEPENDENCIES = Symbol('CERTIFICATION_ISSUER_REQUEST_DEPENDENCIES');
const ISSUER_REQUEST_MAIL_DEPENDENCIES = Symbol('CERTIFICATION_ISSUER_REQUEST_MAIL_DEPENDENCIES');

const issuerRequestUseCases = [
  OwnIssuerRequestCreate,
  IssuerRequestsQueue,
  IssuerRequestRead,
  IssuerRequestDocumentRead,
  IssuerRequestAnswer,
] as const;

const useCaseProviders: readonly FactoryProvider[] = issuerRequestUseCases.map(
  (type): FactoryProvider => ({
    provide: type,
    inject: [USE_CASE_GATE, ISSUER_REQUEST_DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: IssuerRequestDependencies) => new type(gate, deps),
  }),
);

/**
 * "My issuer is not listed" (certification design 2.1, 7.2, 12; slice 6): the request store, the
 * seller's create, the admin queue, read, file read and answer, and the answer mail. The intake,
 * the vault, the cipher, the counters and the review ports are the ones the seller side and the
 * review already bind.
 */
export const issuerRequestProviders: readonly Provider[] = [
  {
    provide: ISSUER_REQUEST_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): IssuerRequestRepository =>
      new PrismaIssuerRequestRepository(prisma),
  },
  {
    provide: ISSUER_REQUEST_DEPENDENCIES,
    inject: [
      UNIT_OF_WORK,
      ISSUER_REQUEST_REPOSITORY,
      CERTIFICATE_TYPE_CATALOG,
      DOCUMENT_VAULT,
      DOCUMENT_INTAKE,
      CERTIFICATE_FIELD_CIPHER,
      RATE_COUNTER_REPOSITORY,
      RATE_COUNTER_KEYS,
      SELLER_ZONES_SOURCE,
      REVIEW_SELLER_SOURCE,
      REVIEW_POLICY_PROVIDER,
      AUDIT_WRITER,
      OUTBOX_WRITER,
      CLOCK,
      ID_GENERATOR,
      APP_CONFIG,
    ],
    useFactory: (
      unitOfWork: UnitOfWork,
      requests: IssuerRequestRepository,
      types: CertificateTypeCatalog,
      vault: DocumentVault,
      intake: DocumentIntake,
      cipher: CertificateFieldCipher,
      counters: RateCounterRepository,
      counterKeys: RateCounterKeys,
      zones: SellerZonesSource,
      sellers: ReviewSellerSource,
      policies: ReviewPolicyProvider,
      audit: AuditWriter,
      outbox: OutboxWriter,
      clock: Clock,
      ids: IdGenerator,
      config: AppConfig,
    ): IssuerRequestDependencies => ({
      unitOfWork,
      requests,
      types,
      vault,
      intake,
      cipher,
      counters,
      counterKeys,
      zones,
      sellers,
      policies,
      audit,
      outbox,
      clock,
      ids,
      documentDownloadEnabled: config.certificationReviewerDocumentsEnabled,
    }),
  },
  {
    provide: ISSUER_REQUEST_MAIL_DEPENDENCIES,
    inject: [
      UNIT_OF_WORK,
      ISSUER_REQUEST_REPOSITORY,
      SELLER_OWNER_CONTACT,
      MAIL_TRANSPORT,
      CERTIFICATION_MAIL_POLICY,
      REVIEW_POLICY_PROVIDER,
    ],
    useFactory: (
      unitOfWork: UnitOfWork,
      requests: IssuerRequestRepository,
      contacts: SellerOwnerContact,
      transport: MailTransport,
      mailPolicy: CertificationMailPolicy,
      policies: ReviewPolicyProvider,
    ): IssuerRequestMailDependencies => ({
      unitOfWork,
      requests,
      contacts,
      transport,
      mailPolicy,
      policies,
    }),
  },
  {
    provide: SendIssuerRequestMail,
    inject: [USE_CASE_GATE, ISSUER_REQUEST_MAIL_DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: IssuerRequestMailDependencies) =>
      new SendIssuerRequestMail(gate, deps),
  },
  ...useCaseProviders,
];
