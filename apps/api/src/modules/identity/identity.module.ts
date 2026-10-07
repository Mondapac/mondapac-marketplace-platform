import { Module } from '@nestjs/common';
import { registerEvents } from '../../platform/events/event-catalogue';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { COMMON_PASSWORD_LIST } from './application/ports/common-password-list';
import { IDENTITY_MARKET_POLICY } from './application/ports/identity-market-policy';
import { PASSWORD_HASHER } from './application/ports/password-hasher';
import { IDENTITY_EVENTS } from './domain/events';
import { MarketConfigIdentityPolicy } from './infrastructure/market-config-identity-policy';
import { Argon2idPasswordHasher } from './infrastructure/passwords/argon2id-password-hasher';
import { CheckedInCommonPasswords } from './infrastructure/passwords/checked-in-common-passwords';

/**
 * The identity bounded context (ADR-0018; docs/design/domain/identity.md), filled slice by
 * slice. Slice 1b binds its outbox writer and registers its events (platform persistence
 * design 5.2, PN6). Slice 1d binds the password hasher (one per process: its queue is the
 * process's), the common-password list and the Market policy.
 */
@Module({
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
  ],
})
export class IdentityModule {}
