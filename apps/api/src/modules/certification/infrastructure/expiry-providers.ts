import type { Provider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import { AUDIT_WRITER, type AuditWriter } from '../../../platform/audit/audit-writer';
import { USE_CASE_GATE, type UseCaseGate } from '../../../platform/authz';
import { CLOCK } from '../../../platform/clock/clock.module';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { MAIL_TRANSPORT, type MailTransport } from '../../../platform/mail/mail-transport';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { SellerZonesSource } from '../application/ports/claim-facts.ports';
import {
  SELLER_OWNER_CONTACT,
  type SellerOwnerContact,
} from '../application/ports/decision-mail.ports';
import {
  EXPIRY_POLICY_PROVIDER,
  SELLER_CERTIFICATE_EXPIRY_REPOSITORY,
  type ExpiryPolicyProvider,
  type SellerCertificateExpiryRepository,
} from '../application/ports/expiry.repository';
import {
  CERTIFICATION_MAIL_POLICY,
  type CertificationMailPolicy,
} from '../application/ports/review.ports';
import { SELLER_ZONES_SOURCE } from '../application/ports/tokens';
import { ExpireSellerCertificates } from '../application/use-cases/expire-seller-certificates.use-case';
import { SendExpiryMail } from '../application/use-cases/send-expiry-mail.use-case';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  assertCertificationConfigured,
  MarketConfigExpiryPolicy,
} from './market-config-expiry-policy';
import { PrismaSellerCertificateExpiryRepository } from './prisma-seller-certificate-expiry.repository';

/**
 * The expiry and warning job and its mails (certification design 3.1, 8.6, 12; slice 9): the
 * expiry store, the Market's warning policy, the job's use case and the mail use case. The seller
 * zones, the Owner contact and the mail sender are the review's bindings.
 */
export const expiryProviders: readonly Provider[] = [
  {
    provide: SELLER_CERTIFICATE_EXPIRY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerCertificateExpiryRepository =>
      new PrismaSellerCertificateExpiryRepository(prisma),
  },
  {
    // Start-up check: every hosted Market has the `certification` section (no default).
    provide: EXPIRY_POLICY_PROVIDER,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): ExpiryPolicyProvider => {
      assertCertificationConfigured(markets);
      return new MarketConfigExpiryPolicy(markets);
    },
  },
  {
    provide: ExpireSellerCertificates,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      SELLER_CERTIFICATE_EXPIRY_REPOSITORY,
      SELLER_ZONES_SOURCE,
      EXPIRY_POLICY_PROVIDER,
      AUDIT_WRITER,
      OUTBOX_WRITER,
      CLOCK,
      ID_GENERATOR,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: UnitOfWork,
      expiries: SellerCertificateExpiryRepository,
      zones: SellerZonesSource,
      policies: ExpiryPolicyProvider,
      audit: AuditWriter,
      outbox: OutboxWriter,
      clock: Clock,
      ids: IdGenerator,
    ) =>
      new ExpireSellerCertificates(gate, {
        unitOfWork,
        expiries,
        zones,
        policies,
        audit,
        outbox,
        clock,
        ids,
      }),
  },
  {
    provide: SendExpiryMail,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      SELLER_CERTIFICATE_EXPIRY_REPOSITORY,
      SELLER_OWNER_CONTACT,
      MAIL_TRANSPORT,
      CERTIFICATION_MAIL_POLICY,
      EXPIRY_POLICY_PROVIDER,
      CLOCK,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: UnitOfWork,
      expiries: SellerCertificateExpiryRepository,
      contacts: SellerOwnerContact,
      transport: MailTransport,
      mailPolicy: CertificationMailPolicy,
      policies: ExpiryPolicyProvider,
      clock: Clock,
    ) =>
      new SendExpiryMail(gate, {
        unitOfWork,
        expiries,
        contacts,
        transport,
        mailPolicy,
        policies,
        clock,
      }),
  },
];
