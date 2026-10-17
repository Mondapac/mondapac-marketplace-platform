import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import type { CustomersDependencies } from './application/customers-dependencies';
import { ADDRESS_CIPHER } from './application/ports/address-cipher';
import { ADDRESS_POLICY } from './application/ports/address-policy';
import { ADDRESS_REPOSITORY } from './application/ports/address.repository';
import { CreateAddress } from './application/use-cases/create-address.use-case';
import { DeleteAddress } from './application/use-cases/delete-address.use-case';
import { ListAddresses } from './application/use-cases/list-addresses.use-case';
import { SetDefaultAddress } from './application/use-cases/set-default-address.use-case';
import { UpdateAddress } from './application/use-cases/update-address.use-case';
import { customersProviders } from './infrastructure/customers-providers';
import { AddressBookController } from './presentation/address-book.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: CustomersDependencies) => U;

const PORTS: readonly [keyof CustomersDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['addresses', ADDRESS_REPOSITORY],
  ['cipher', ADDRESS_CIPHER],
  ['policy', ADDRESS_POLICY],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

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
 * every use case is the customer's own (`own-resources`). Checkout picks an address in package 2.
 */
@Module({
  controllers: [AddressBookController],
  providers: [
    ...customersProviders,
    ...[ListAddresses, CreateAddress, UpdateAddress, DeleteAddress, SetDefaultAddress].map((type) =>
      useCaseProvider(type as UseCaseClass<unknown>),
    ),
  ],
})
export class CustomersModule {}
