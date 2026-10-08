import { Module } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER, type OutboxWriter } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { ACCOUNT_REPOSITORY, type AccountRepository } from './application/ports/account.repository';
import {
  COMMON_PASSWORD_LIST,
  type CommonPasswordList,
} from './application/ports/common-password-list';
import {
  IDENTITY_MARKET_POLICY,
  type IdentityMarketPolicy,
} from './application/ports/identity-market-policy';
import { PASSWORD_HASHER, type PasswordHasher } from './application/ports/password-hasher';
import { RegisterCustomer } from './application/use-cases/register-customer.use-case';
import { IDENTITY_EVENTS } from './domain/events';
import { accountRepositoryProvider } from './infrastructure/account-repository.provider';
import { MarketConfigIdentityPolicy } from './infrastructure/market-config-identity-policy';
import { Argon2idPasswordHasher } from './infrastructure/passwords/argon2id-password-hasher';
import { CheckedInCommonPasswords } from './infrastructure/passwords/checked-in-common-passwords';
import { CustomerSignUpController } from './presentation/customer-sign-up.controller';

/**
 * The identity bounded context (ADR-0018; docs/design/domain/identity.md), filled slice by
 * slice. Slice 1b binds its outbox writer and registers its events (platform persistence
 * design 5.2, PN6). Slice 1d binds the password hasher (one per process: its queue is the
 * process's), the common-password list, the Market policy, the account repository, the
 * customer sign-up use case and its controller.
 */
@Module({
  controllers: [CustomerSignUpController],
  providers: [
    PersistenceModule.outboxWriterFor('identity'),
    registerEvents('identity', IDENTITY_EVENTS),
    { provide: PASSWORD_HASHER, useFactory: () => new Argon2idPasswordHasher() },
    { provide: COMMON_PASSWORD_LIST, useFactory: () => new CheckedInCommonPasswords() },
    {
      provide: IDENTITY_MARKET_POLICY,
      inject: [MarketRegistry],
      useFactory: (markets: MarketRegistry) => new MarketConfigIdentityPolicy(markets),
    },
    accountRepositoryProvider,
    {
      provide: RegisterCustomer,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        ACCOUNT_REPOSITORY,
        OUTBOX_WRITER,
        PASSWORD_HASHER,
        COMMON_PASSWORD_LIST,
        IDENTITY_MARKET_POLICY,
        CLOCK,
        ID_GENERATOR,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        accounts: AccountRepository,
        outbox: OutboxWriter,
        hasher: PasswordHasher,
        commonPasswords: CommonPasswordList,
        policy: IdentityMarketPolicy,
        clock: Clock,
        ids: IdGenerator,
      ) =>
        new RegisterCustomer(gate, {
          unitOfWork,
          accounts,
          outbox,
          hasher,
          commonPasswords,
          policy,
          clock,
          ids,
        }),
    },
  ],
})
export class IdentityModule {}
