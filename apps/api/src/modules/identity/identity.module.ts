import { Module } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import {
  AUTHENTICATOR,
  AUTHORISATION_CHECK,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER, type OutboxWriter } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { AccountAuthorisationCheck } from './application/access/account-authorisation-check';
import { SessionAuthenticator } from './application/access/session-authenticator';
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
import { SESSION_REPOSITORY, type SessionRepository } from './application/ports/session.repository';
import {
  SESSION_TOKENS,
  THROTTLE_KEYS,
  type SessionTokens,
  type ThrottleKeys,
} from './application/ports/session-secrets';
import {
  SIGN_IN_RECORD_REPOSITORY,
  type SignInRecordRepository,
} from './application/ports/sign-in-record.repository';
import {
  THROTTLE_REPOSITORY,
  type ThrottleRepository,
} from './application/ports/throttle.repository';
import { DescribeActor } from './application/use-cases/describe-actor.use-case';
import { PurgeExpired } from './application/use-cases/purge-expired.use-case';
import { RegisterCustomer } from './application/use-cases/register-customer.use-case';
import { SignInCustomer } from './application/use-cases/sign-in-customer.use-case';
import { SignOut } from './application/use-cases/sign-out.use-case';
import { IDENTITY_FACADE } from './contracts/identity.facade';
import { IDENTITY_EVENTS } from './domain/events';
import { accountRepositoryProvider } from './infrastructure/account-repository.provider';
import { MarketConfigIdentityPolicy } from './infrastructure/market-config-identity-policy';
import { Argon2idPasswordHasher } from './infrastructure/passwords/argon2id-password-hasher';
import { CheckedInCommonPasswords } from './infrastructure/passwords/checked-in-common-passwords';
import { sessionProviders } from './infrastructure/sessions/session-providers';
import { CustomerSessionController } from './presentation/customer-session.controller';
import { CustomerSignUpController } from './presentation/customer-sign-up.controller';
import { IdentityFacadeImplementation } from './presentation/identity.facade';
import { purgeExpiredJob } from './presentation/jobs/purge-expired.job';

/**
 * The identity bounded context (ADR-0018; docs/design/domain/identity.md), filled slice by
 * slice. Slice 1b binds its outbox writer and registers its events (platform persistence
 * design 5.2, PN6). Slice 1d binds the password hasher (one per process: its queue is the
 * process's), the common-password list, the Market policy, the account repository, the
 * customer sign-up use case and its controller.
 *
 * Slice 2 binds the session, throttle and sign-in-record stores, the session tokens and the
 * throttle keys; the customer sign-in, sign-out and summary use cases and their controller; the
 * `identity.purge-expired` job; the facade; and the two ports `platform/` calls, exported for
 * it: the `Authenticator` (the actor guard) and the `AuthorisationCheck` (the gate, through
 * `AuthzModule.register(IdentityModule)`).
 */
@Module({
  controllers: [CustomerSignUpController, CustomerSessionController],
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
    ...sessionProviders,
    {
      provide: AUTHENTICATOR,
      inject: [UNIT_OF_WORK, SESSION_REPOSITORY, SESSION_TOKENS, CLOCK],
      useFactory: (
        unitOfWork: UnitOfWork,
        sessions: SessionRepository,
        tokens: SessionTokens,
        clock: Clock,
      ) => new SessionAuthenticator({ unitOfWork, sessions, tokens, clock }),
    },
    {
      provide: AUTHORISATION_CHECK,
      inject: [UNIT_OF_WORK, ACCOUNT_REPOSITORY],
      useFactory: (unitOfWork: UnitOfWork, accounts: AccountRepository) =>
        new AccountAuthorisationCheck({ unitOfWork, accounts }),
    },
    {
      provide: RegisterCustomer,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        ACCOUNT_REPOSITORY,
        THROTTLE_REPOSITORY,
        THROTTLE_KEYS,
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
        throttles: ThrottleRepository,
        keys: ThrottleKeys,
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
          throttles,
          keys,
          outbox,
          hasher,
          commonPasswords,
          policy,
          clock,
          ids,
        }),
    },
    {
      provide: SignInCustomer,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        ACCOUNT_REPOSITORY,
        SESSION_REPOSITORY,
        THROTTLE_REPOSITORY,
        SIGN_IN_RECORD_REPOSITORY,
        PASSWORD_HASHER,
        SESSION_TOKENS,
        THROTTLE_KEYS,
        IDENTITY_MARKET_POLICY,
        CLOCK,
        ID_GENERATOR,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        accounts: AccountRepository,
        sessions: SessionRepository,
        throttles: ThrottleRepository,
        records: SignInRecordRepository,
        hasher: PasswordHasher,
        tokens: SessionTokens,
        keys: ThrottleKeys,
        policy: IdentityMarketPolicy,
        clock: Clock,
        ids: IdGenerator,
      ) =>
        new SignInCustomer(gate, {
          unitOfWork,
          accounts,
          sessions,
          throttles,
          records,
          hasher,
          tokens,
          keys,
          policy,
          clock,
          ids,
        }),
    },
    {
      provide: SignOut,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, SESSION_REPOSITORY, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        sessions: SessionRepository,
        clock: Clock,
      ) => new SignOut(gate, { unitOfWork, sessions, clock }),
    },
    {
      provide: DescribeActor,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, ACCOUNT_REPOSITORY, SESSION_REPOSITORY],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        accounts: AccountRepository,
        sessions: SessionRepository,
      ) => new DescribeActor(gate, { unitOfWork, accounts, sessions }),
    },
    {
      provide: PurgeExpired,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        SESSION_REPOSITORY,
        THROTTLE_REPOSITORY,
        SIGN_IN_RECORD_REPOSITORY,
        IDENTITY_MARKET_POLICY,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        sessions: SessionRepository,
        throttles: ThrottleRepository,
        records: SignInRecordRepository,
        policy: IdentityMarketPolicy,
        clock: Clock,
      ) => new PurgeExpired(gate, { unitOfWork, sessions, throttles, records, policy, clock }),
    },
    {
      provide: IDENTITY_FACADE,
      inject: [DescribeActor],
      useFactory: (describe: DescribeActor) => new IdentityFacadeImplementation(describe),
    },
    registerJobsFrom('identity', [PurgeExpired], (purge: PurgeExpired) => [purgeExpiredJob(purge)]),
  ],
  exports: [AUTHENTICATOR, AUTHORISATION_CHECK, IDENTITY_FACADE],
})
export class IdentityModule {}
