import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import {
  registerPermissions,
  registerStepUpActions,
  STEP_UP_CONSUMER,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import type { AccountDeletionDependencies } from './application/account-deletion-dependencies';
import type { CustomersDependencies } from './application/customers-dependencies';
import {
  ACCOUNT_DELETION_PEERS,
  type AccountDeletionPeers,
} from './application/ports/account-deletion-peers';
import { ACCOUNT_DELETION_REQUEST_REPOSITORY } from './application/ports/account-deletion-request.repository';
import { CancelAccountDeletion } from './application/use-cases/cancel-account-deletion.use-case';
import { ExecuteAccountDeletions } from './application/use-cases/execute-account-deletions.use-case';
import { RequestAccountDeletion } from './application/use-cases/request-account-deletion.use-case';
import { ViewAccountDeletionRequest } from './application/use-cases/view-account-deletion-request.use-case';
import { ACCOUNT_DELETION_SETTINGS_REPOSITORY } from './application/ports/account-deletion-settings.repository';
import { ADDRESS_CIPHER } from './application/ports/address-cipher';
import { ADDRESS_POLICY } from './application/ports/address-policy';
import { ADDRESS_REPOSITORY } from './application/ports/address.repository';
import { SetAccountDeletionSettings } from './application/use-cases/set-account-deletion-settings.use-case';
import { ViewAccountDeletionAvailability } from './application/use-cases/view-account-deletion-availability.use-case';
import { ViewAccountDeletionSettings } from './application/use-cases/view-account-deletion-settings.use-case';
import { CreateAddress } from './application/use-cases/create-address.use-case';
import { DeleteAddress } from './application/use-cases/delete-address.use-case';
import { ListAddresses } from './application/use-cases/list-addresses.use-case';
import { ReadDeliveryAddress } from './application/use-cases/read-delivery-address.use-case';
import { SetDefaultAddress } from './application/use-cases/set-default-address.use-case';
import { UpdateAddress } from './application/use-cases/update-address.use-case';
import {
  CUSTOMERS_ACCOUNT_DELETION_FACADE,
  CUSTOMERS_CHECKOUT_FACADE,
  CUSTOMERS_PERMISSIONS,
  CUSTOMERS_STEP_UP_ACTIONS,
} from './contracts';
import { CUSTOMERS_AUDIT_ACTIONS } from './domain/audit';
import { CUSTOMERS_EVENTS } from './domain/events';
import { customersProviders } from './infrastructure/customers-providers';
import { AccountDeletionRequestController } from './presentation/account-deletion-request.controller';
import { CustomersAccountDeletionFacadeImplementation } from './presentation/customers-account-deletion.facade';
import { executeAccountDeletionsJob } from './presentation/jobs/execute-account-deletions.job';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { AccountDeletionController } from './presentation/account-deletion.controller';
import { AdminAccountDeletionSettingsController } from './presentation/admin-account-deletion-settings.controller';
import { AddressBookController } from './presentation/address-book.controller';
import { CustomersCheckoutFacadeImplementation } from './presentation/customers-checkout.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: CustomersDependencies) => U;

const PORTS: readonly [keyof CustomersDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['addresses', ADDRESS_REPOSITORY],
  ['cipher', ADDRESS_CIPHER],
  ['policy', ADDRESS_POLICY],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
  ['accountDeletionSettings', ACCOUNT_DELETION_SETTINGS_REPOSITORY],
  ['audit', AUDIT_WRITER],
  ['outbox', OUTBOX_WRITER],
  ['stepUp', STEP_UP_CONSUMER],
];

type DeletionUseCaseClass<U> = new (gate: UseCaseGate, deps: AccountDeletionDependencies) => U;

const DELETION_PORTS: readonly [keyof AccountDeletionDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['requests', ACCOUNT_DELETION_REQUEST_REPOSITORY],
  ['addresses', ADDRESS_REPOSITORY],
  ['accountDeletionSettings', ACCOUNT_DELETION_SETTINGS_REPOSITORY],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
  ['audit', AUDIT_WRITER],
  ['outbox', OUTBOX_WRITER],
];

/** The deletion flow's use cases: the same ports, plus the peers bound at start. */
function deletionUseCaseProvider<U>(type: DeletionUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ACCOUNT_DELETION_PEERS, ...DELETION_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, peers: AccountDeletionPeers, ...values: unknown[]) =>
      new type(gate, {
        ...Object.fromEntries(DELETION_PORTS.map(([name], index) => [name, values[index]])),
        ...peers,
      } as unknown as AccountDeletionDependencies),
  };
}

/** Every customers use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as CustomersDependencies,
      ),
  };
}

/**
 * Customers: the buyer's own data beside the `identity` account (customers package 1: the
 * delivery address book). A signed-in customer keeps up to the Market's limit of addresses, one of
 * them the default; each address is sealed under the account's subject key. No permission key:
 * every buyer use case is the customer's own (`own-resources`); the setting has a plain view key
 * and a protected manage key. Package 2: checkout reads the chosen
 * address through `CUSTOMERS_CHECKOUT_FACADE` and copies it onto the order. Package 5a: the
 * Market's account deletion setting (an admin switches buyer deletion on and sets its waiting
 * period; each change is an insert-only version, an audit row and an outbox event) and the
 * customer's read of it.
 */
@Module({
  controllers: [
    AddressBookController,
    AccountDeletionController,
    AccountDeletionRequestController,
    AdminAccountDeletionSettingsController,
  ],
  providers: [
    PersistenceModule.auditWriterFor('customers'),
    PersistenceModule.outboxWriterFor('customers'),
    registerAuditActions('customers', CUSTOMERS_AUDIT_ACTIONS),
    registerEvents('customers', CUSTOMERS_EVENTS),
    registerPermissions('customers', CUSTOMERS_PERMISSIONS),
    registerStepUpActions('customers', CUSTOMERS_STEP_UP_ACTIONS),
    ...customersProviders,
    ...[
      ListAddresses,
      CreateAddress,
      UpdateAddress,
      DeleteAddress,
      SetDefaultAddress,
      ReadDeliveryAddress,
      ViewAccountDeletionSettings,
      SetAccountDeletionSettings,
      ViewAccountDeletionAvailability,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    ...[
      RequestAccountDeletion,
      ViewAccountDeletionRequest,
      CancelAccountDeletion,
      ExecuteAccountDeletions,
    ].map((type) => deletionUseCaseProvider(type as DeletionUseCaseClass<unknown>)),
    {
      provide: CUSTOMERS_ACCOUNT_DELETION_FACADE,
      inject: [CancelAccountDeletion],
      useFactory: (cancel: CancelAccountDeletion) =>
        new CustomersAccountDeletionFacadeImplementation(cancel),
    },
    registerJobsFrom('customers', [ExecuteAccountDeletions], (execute: ExecuteAccountDeletions) => [
      executeAccountDeletionsJob(execute),
    ]),
    {
      provide: CUSTOMERS_CHECKOUT_FACADE,
      inject: [ReadDeliveryAddress],
      useFactory: (read: ReadDeliveryAddress) => new CustomersCheckoutFacadeImplementation(read),
    },
  ],
  exports: [CUSTOMERS_CHECKOUT_FACADE, CUSTOMERS_ACCOUNT_DELETION_FACADE, ACCOUNT_DELETION_PEERS],
})
export class CustomersModule {}
