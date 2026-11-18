import type { IdGenerator } from '@mondapac/shared-kernel';
import { LEGAL_EVENTS } from '../../src/modules/legal/domain/events';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS, type OutboxWriter } from '../../src/platform/events/outbox-writer';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { modelMap, type Persistence } from './persistence-support';

/** The real outbox writer of the legal module, for the database specs of its flows. */
export function legalOutbox(db: Persistence, ids: IdGenerator): OutboxWriter {
  const catalogue = new EventCatalogue();
  catalogue.register('legal', LEGAL_EVENTS);
  catalogue.seal();
  return new PrismaOutboxWriterFactory(
    modelMap,
    db.service,
    catalogue,
    ids,
    NO_PERMISSION_KEYS,
  ).forModule('legal');
}
