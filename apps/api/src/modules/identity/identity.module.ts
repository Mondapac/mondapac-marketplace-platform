import { Module } from '@nestjs/common';
import { registerEvents } from '../../platform/events/event-catalogue';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { IDENTITY_EVENTS } from './domain/events';

/**
 * The identity bounded context (ADR-0018; docs/design/domain/identity.md), filled slice by
 * slice. Slice 1b binds its outbox writer and registers its events (platform persistence
 * design 5.2, PN6).
 */
@Module({
  providers: [
    PersistenceModule.outboxWriterFor('identity'),
    registerEvents('identity', IDENTITY_EVENTS),
  ],
})
export class IdentityModule {}
