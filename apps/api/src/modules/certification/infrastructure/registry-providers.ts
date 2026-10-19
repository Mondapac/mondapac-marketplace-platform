import type { FactoryProvider, Provider } from '@nestjs/common';
import type { Clock, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import { AUDIT_WRITER, type AuditWriter } from '../../../platform/audit/audit-writer';
import { USE_CASE_GATE, type UseCaseGate } from '../../../platform/authz';
import { CLOCK } from '../../../platform/clock/clock.module';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { MAIL_TRANSPORT, type MailTransport } from '../../../platform/mail/mail-transport';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  SELLER_OWNER_CONTACT,
  type SellerOwnerContact,
} from '../application/ports/decision-mail.ports';
import { REGISTRY_CIPHER, type RegistryCipher } from '../application/ports/registry-cipher';
import {
  CERTIFICATION_REGISTRY_REPOSITORY,
  type CertificationRegistryRepository,
} from '../application/ports/registry.repository';
import {
  CERTIFICATION_MAIL_POLICY,
  type CertificationMailPolicy,
} from '../application/ports/review.ports';
import type { RegistryDependencies } from '../application/registry/registry.shared';
import { IssuerActivate } from '../application/use-cases/issuer-activate.use-case';
import { IssuerApproveReactivation } from '../application/use-cases/issuer-approve-reactivation.use-case';
import { IssuerCloseToNew } from '../application/use-cases/issuer-close-to-new.use-case';
import { IssuerCreate } from '../application/use-cases/issuer-create.use-case';
import { IssuerDerecognise } from '../application/use-cases/issuer-derecognise.use-case';
import { IssuerExpertReferenceRead } from '../application/use-cases/issuer-expert-reference-read.use-case';
import { IssuerProposalReject } from '../application/use-cases/issuer-proposal-reject.use-case';
import { IssuerProposalWithdraw } from '../application/use-cases/issuer-proposal-withdraw.use-case';
import { IssuerRead } from '../application/use-cases/issuer-read.use-case';
import { IssuerRequestReactivation } from '../application/use-cases/issuer-request-reactivation.use-case';
import { IssuersList } from '../application/use-cases/issuers-list.use-case';
import {
  SendDerecognitionMail,
  type DerecognitionMailDependencies,
} from '../application/use-cases/send-derecognition-mail.use-case';
import { TypeApproveReactivation } from '../application/use-cases/type-approve-reactivation.use-case';
import { TypeApproveRelaxation } from '../application/use-cases/type-approve-relaxation.use-case';
import { TypeDeactivate } from '../application/use-cases/type-deactivate.use-case';
import { TypeProposalReject } from '../application/use-cases/type-proposal-reject.use-case';
import { TypeProposalWithdraw } from '../application/use-cases/type-proposal-withdraw.use-case';
import { TypeRead } from '../application/use-cases/type-read.use-case';
import { TypeRequestReactivation } from '../application/use-cases/type-request-reactivation.use-case';
import { TypeSaveRevision } from '../application/use-cases/type-save-revision.use-case';
import { TypesList } from '../application/use-cases/types-list.use-case';
import { PrismaCertificationRegistryRepository } from './prisma-certification-registry.repository';
import { SubjectKeyRegistryCipher } from './subject-key-registry-cipher';

export const REGISTRY_DEPENDENCIES = Symbol('CERTIFICATION_REGISTRY_DEPENDENCIES');
const DERECOGNITION_MAIL_DEPENDENCIES = Symbol('CERTIFICATION_DERECOGNITION_MAIL_DEPENDENCIES');

/** The admin use cases behind the type and registry pages (slice 12). */
export const registryUseCases = [
  TypesList,
  TypeRead,
  TypeSaveRevision,
  TypeDeactivate,
  TypeRequestReactivation,
  TypeApproveRelaxation,
  TypeApproveReactivation,
  TypeProposalReject,
  TypeProposalWithdraw,
  IssuersList,
  IssuerRead,
  IssuerExpertReferenceRead,
  IssuerCreate,
  IssuerActivate,
  IssuerCloseToNew,
  IssuerDerecognise,
  IssuerRequestReactivation,
  IssuerApproveReactivation,
  IssuerProposalReject,
  IssuerProposalWithdraw,
] as const;

const useCaseProviders: readonly FactoryProvider[] = registryUseCases.map(
  (type): FactoryProvider => ({
    provide: type,
    inject: [USE_CASE_GATE, REGISTRY_DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: RegistryDependencies) => new type(gate, deps),
  }),
);

/**
 * The type and issuer registry (certification design 3.5, 3.6, 7.1, 7.2, 12; slice 12): the
 * store, the cipher of the admin text, the admin use cases and the derecognition mail.
 */
export const registryProviders: readonly Provider[] = [
  {
    provide: CERTIFICATION_REGISTRY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CertificationRegistryRepository =>
      new PrismaCertificationRegistryRepository(prisma),
  },
  {
    provide: REGISTRY_CIPHER,
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
    ): RegistryCipher => new SubjectKeyRegistryCipher(keys, unitOfWork, registry, ids, clock),
  },
  {
    provide: REGISTRY_DEPENDENCIES,
    inject: [
      UNIT_OF_WORK,
      CERTIFICATION_REGISTRY_REPOSITORY,
      REGISTRY_CIPHER,
      AUDIT_WRITER,
      OUTBOX_WRITER,
      CLOCK,
      ID_GENERATOR,
      MarketRegistry,
    ],
    useFactory: (
      unitOfWork: UnitOfWork,
      registry: CertificationRegistryRepository,
      cipher: RegistryCipher,
      audit: AuditWriter,
      outbox: OutboxWriter,
      clock: Clock,
      ids: IdGenerator,
      markets: MarketRegistry,
    ): RegistryDependencies => ({
      unitOfWork,
      registry,
      cipher,
      audit,
      outbox,
      clock,
      ids,
      supportedLocales: (market: MarketContext) => markets.get(market.marketId).supportedLocales,
    }),
  },
  {
    provide: DERECOGNITION_MAIL_DEPENDENCIES,
    inject: [
      UNIT_OF_WORK,
      CERTIFICATION_REGISTRY_REPOSITORY,
      SELLER_OWNER_CONTACT,
      MAIL_TRANSPORT,
      CERTIFICATION_MAIL_POLICY,
    ],
    useFactory: (
      unitOfWork: UnitOfWork,
      registry: CertificationRegistryRepository,
      contacts: SellerOwnerContact,
      transport: MailTransport,
      mailPolicy: CertificationMailPolicy,
    ): DerecognitionMailDependencies => ({ unitOfWork, registry, contacts, transport, mailPolicy }),
  },
  {
    provide: SendDerecognitionMail,
    inject: [USE_CASE_GATE, DERECOGNITION_MAIL_DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: DerecognitionMailDependencies) =>
      new SendDerecognitionMail(gate, deps),
  },
  ...useCaseProviders,
];
