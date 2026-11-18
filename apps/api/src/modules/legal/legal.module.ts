import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import type { LegalDependencies } from './application/legal-dependencies';
import { MARKETING_CONSENT_REPOSITORY } from './application/ports/marketing-consent.repository';
import { MarketingEmailConsentOf } from './application/use-cases/marketing-email-consent-of.use-case';
import { SetEmailPreferences } from './application/use-cases/set-email-preferences.use-case';
import { ViewEmailPreferences } from './application/use-cases/view-email-preferences.use-case';
import { WithdrawMarketingEmailByLink } from './application/use-cases/withdraw-marketing-email-by-link.use-case';
import { AdminCustomerConsentHistory } from './application/use-cases/admin-customer-consent-history.use-case';
import { AdminCustomerConsent } from './application/use-cases/admin-customer-consent.use-case';
import { CUSTOMER_CONSENT_FACADE } from './contracts/customer-consent.facade';
import { LEGAL_FACADE } from './contracts/legal.facade';
import { LEGAL_PERMISSIONS } from './contracts/permissions';
import { LEGAL_EVENTS } from './domain/events';
import { CustomerConsentFacadeImplementation } from './presentation/customer-consent.facade';
import { legalProviders } from './infrastructure/legal-providers';
import { EmailPreferencesController } from './presentation/email-preferences.controller';
import { LegalFacadeImplementation } from './presentation/legal.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: LegalDependencies) => U;

const PORTS: readonly [keyof LegalDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['consents', MARKETING_CONSENT_REPOSITORY],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
  ['outbox', OUTBOX_WRITER],
];

/** Every legal use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as LegalDependencies,
      ),
  };
}

/**
 * Legal: the records the platform keeps for the law (ADR-0020 decision 5). So far the marketing
 * consent (personalization package 1b, customers package 4): a customer's express opt-in to
 * marketing email and every change of it, with its source. notifications asks it before a
 * marketing send and withdraws it through the one-click unsubscribe link. One permission key,
 * `legal.customer-consent.view`: the admin's read of a customer's consent on the customer page.
 * Since customers phase 2b, part 4, every change is announced in legal's outbox as
 * `legal.marketing-consent-changed.v1` (account and channel, never the value).
 */
@Module({
  controllers: [EmailPreferencesController],
  providers: [
    PersistenceModule.outboxWriterFor('legal'),
    registerEvents('legal', LEGAL_EVENTS),
    ...legalProviders,
    ...[
      ViewEmailPreferences,
      SetEmailPreferences,
      MarketingEmailConsentOf,
      WithdrawMarketingEmailByLink,
      // Customers management phase 2b: the admin's reads of one customer's consent.
      AdminCustomerConsent,
      AdminCustomerConsentHistory,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: LEGAL_FACADE,
      inject: [MarketingEmailConsentOf, WithdrawMarketingEmailByLink],
      useFactory: (
        marketingEmailConsentOf: MarketingEmailConsentOf,
        withdrawMarketingEmailByLink: WithdrawMarketingEmailByLink,
      ) => new LegalFacadeImplementation({ marketingEmailConsentOf, withdrawMarketingEmailByLink }),
    },
    {
      provide: CUSTOMER_CONSENT_FACADE,
      inject: [AdminCustomerConsent, AdminCustomerConsentHistory],
      useFactory: (consent: AdminCustomerConsent, history: AdminCustomerConsentHistory) =>
        new CustomerConsentFacadeImplementation(consent, history),
    },
    registerPermissions('legal', LEGAL_PERMISSIONS),
  ],
  exports: [LEGAL_FACADE, CUSTOMER_CONSENT_FACADE],
})
export class LegalModule {}
