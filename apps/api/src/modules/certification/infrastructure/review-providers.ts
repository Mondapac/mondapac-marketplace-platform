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
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { IDENTITY_FACADE, type IdentityFacade } from '../../identity';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import type { ReviewDependencies } from '../application/review/review.shared';
import type { SellerZonesSource } from '../application/ports/claim-facts.ports';
import {
  SELLER_OWNER_CONTACT,
  type SellerOwnerContact,
} from '../application/ports/decision-mail.ports';
import {
  CERTIFICATE_FIELD_CIPHER,
  DOCUMENT_VAULT,
  type CertificateFieldCipher,
  type DocumentVault,
} from '../application/ports/document-ports';
import {
  CERTIFICATE_REVIEW_REPOSITORY,
  type CertificateReviewRepository,
} from '../application/ports/review.repository';
import {
  CERTIFICATION_MAIL_POLICY,
  REVIEW_POLICY_PROVIDER,
  REVIEW_SELLER_SOURCE,
  type CertificationMailPolicy,
  type ReviewPolicyProvider,
  type ReviewSellerSource,
} from '../application/ports/review.ports';
import { SELLER_ZONES_SOURCE } from '../application/ports/tokens';
import { SellerCertificateOverview } from '../application/use-cases/seller-certificate-overview.use-case';
import { ApproveSellerCertificate } from '../application/use-cases/seller-certificate-approve.use-case';
import { DeclineSellerCertificate } from '../application/use-cases/seller-certificate-decline.use-case';
import { SellerCertificateRecordCheck } from '../application/use-cases/seller-certificate-record-check.use-case';
import { SellerCertificateRecordConfirmation } from '../application/use-cases/seller-certificate-record-confirmation.use-case';
import { SellerCertificateHistoryRead } from '../application/use-cases/seller-certificate-history-read.use-case';
import { SellerCertificateRecordScope } from '../application/use-cases/seller-certificate-record-scope.use-case';
import { RequestChangesSellerCertificate } from '../application/use-cases/seller-certificate-request-changes.use-case';
import { SellerCertificateReviewDocumentRead } from '../application/use-cases/seller-certificate-review-document-read.use-case';
import { SellerCertificateReviewRead } from '../application/use-cases/seller-certificate-review-read.use-case';
import { RevokeSellerCertificate } from '../application/use-cases/seller-certificate-revoke.use-case';
import { SellerCertificatesQueue } from '../application/use-cases/seller-certificates-queue.use-case';
import {
  SendDecisionMail,
  type DecisionMailDependencies,
} from '../application/use-cases/send-decision-mail.use-case';
import { ConfigCertificationMailPolicy } from './config-certification-mail-policy';
import { IdentitySellerOwnerContact } from './identity-seller-owner-contact';
import { PrismaCertificateReviewRepository } from './prisma-certificate-review.repository';
import { CheckedInReviewPolicy } from './review-policy/checked-in-review-policy';
import { SellersReviewSource } from './sellers-review.source';

const REVIEW_DEPENDENCIES = Symbol('CERTIFICATION_REVIEW_DEPENDENCIES');
const DECISION_MAIL_DEPENDENCIES = Symbol('CERTIFICATION_DECISION_MAIL_DEPENDENCIES');

/** The admin review use cases: the gate and the shared dependencies. */
export const reviewUseCases = [
  SellerCertificatesQueue,
  SellerCertificateReviewRead,
  SellerCertificateReviewDocumentRead,
  SellerCertificateRecordCheck,
  SellerCertificateRecordScope,
  SellerCertificateRecordConfirmation,
  ApproveSellerCertificate,
  RequestChangesSellerCertificate,
  DeclineSellerCertificate,
  RevokeSellerCertificate,
  SellerCertificateHistoryRead,
  SellerCertificateOverview,
] as const;

const reviewUseCaseProviders: readonly FactoryProvider[] = reviewUseCases.map(
  (type): FactoryProvider => ({
    provide: type,
    inject: [USE_CASE_GATE, REVIEW_DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: ReviewDependencies) => new type(gate, deps),
  }),
);

/**
 * The admin review of a seller certificate (certification design 7, 12; slice 7): the review
 * store, the Market's checks, the `sellers` and `identity` reads through their facades, the
 * use cases and the decision mail.
 */
export const reviewProviders: readonly Provider[] = [
  {
    provide: CERTIFICATE_REVIEW_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CertificateReviewRepository =>
      new PrismaCertificateReviewRepository(prisma),
  },
  {
    provide: REVIEW_SELLER_SOURCE,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): ReviewSellerSource => new SellersReviewSource(sellers),
  },
  {
    // Start-up check: the folder exists and every hosted Market has a policy file.
    provide: REVIEW_POLICY_PROVIDER,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): ReviewPolicyProvider =>
      new CheckedInReviewPolicy(undefined, markets.hostedMarketIds()),
  },
  {
    provide: SELLER_OWNER_CONTACT,
    inject: [IDENTITY_FACADE],
    useFactory: (identity: IdentityFacade): SellerOwnerContact =>
      new IdentitySellerOwnerContact(identity),
  },
  {
    provide: CERTIFICATION_MAIL_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): CertificationMailPolicy =>
      new ConfigCertificationMailPolicy(markets),
  },
  {
    provide: REVIEW_DEPENDENCIES,
    inject: [
      UNIT_OF_WORK,
      CERTIFICATE_REVIEW_REPOSITORY,
      CERTIFICATE_FIELD_CIPHER,
      DOCUMENT_VAULT,
      AUDIT_WRITER,
      SELLER_ZONES_SOURCE,
      REVIEW_SELLER_SOURCE,
      REVIEW_POLICY_PROVIDER,
      OUTBOX_WRITER,
      CLOCK,
      ID_GENERATOR,
      APP_CONFIG,
    ],
    useFactory: (
      unitOfWork: UnitOfWork,
      reviews: CertificateReviewRepository,
      cipher: CertificateFieldCipher,
      vault: DocumentVault,
      audit: AuditWriter,
      zones: SellerZonesSource,
      sellers: ReviewSellerSource,
      policies: ReviewPolicyProvider,
      outbox: OutboxWriter,
      clock: Clock,
      ids: IdGenerator,
      config: AppConfig,
    ): ReviewDependencies => ({
      unitOfWork,
      reviews,
      cipher,
      vault,
      audit,
      zones,
      sellers,
      policies,
      outbox,
      clock,
      ids,
      documentDownloadEnabled: config.certificationReviewerDocumentsEnabled,
    }),
  },
  {
    provide: DECISION_MAIL_DEPENDENCIES,
    inject: [
      UNIT_OF_WORK,
      CERTIFICATE_REVIEW_REPOSITORY,
      SELLER_OWNER_CONTACT,
      MAIL_TRANSPORT,
      CERTIFICATION_MAIL_POLICY,
      REVIEW_POLICY_PROVIDER,
    ],
    useFactory: (
      unitOfWork: UnitOfWork,
      reviews: CertificateReviewRepository,
      contacts: SellerOwnerContact,
      transport: MailTransport,
      mailPolicy: CertificationMailPolicy,
      policies: ReviewPolicyProvider,
    ): DecisionMailDependencies => ({
      unitOfWork,
      reviews,
      contacts,
      transport,
      mailPolicy,
      policies,
    }),
  },
  {
    provide: SendDecisionMail,
    inject: [USE_CASE_GATE, DECISION_MAIL_DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: DecisionMailDependencies) =>
      new SendDecisionMail(gate, deps),
  },
  ...reviewUseCaseProviders,
];
