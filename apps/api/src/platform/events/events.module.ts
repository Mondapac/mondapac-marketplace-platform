import { Global, Module } from '@nestjs/common';
import { EventCatalogue } from './event-catalogue';
import { NO_PERMISSION_KEYS, PERMISSION_KEY_LOOKUP } from './outbox-writer';

/**
 * Domain events (platform persistence design, "P", 5 and 6): the event catalogue every module
 * registers with, and the permission-key lookup the outbox writer checks `permissionKey`
 * fields against. The writer, the relay and the bus adapter are bound by the persistence
 * module, which implements them (P 12.1).
 */
@Global()
@Module({
  providers: [EventCatalogue, { provide: PERMISSION_KEY_LOOKUP, useValue: NO_PERMISSION_KEYS }],
  exports: [EventCatalogue, PERMISSION_KEY_LOOKUP],
})
export class EventsModule {}
