import { Global, Module } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import { MODEL_MAP } from '../../generated/model-map';
import { CLOCK } from '../clock/clock.module';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { EVENT_BUS, OUTBOX_RELAY, type EventBus } from '../events/event-bus';
import { EventCatalogue } from '../events/event-catalogue';
import {
  OUTBOX_WRITER_FACTORY,
  PERMISSION_KEY_LOOKUP,
  type PermissionKeyLookup,
} from '../events/outbox-writer';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketRegistry } from '../market-config/market-registry';
import { MarketContextFactory } from '../market-context/market-context.factory';
import { JOB_LOCK } from '../scheduler/job-lock';
import { UNIT_OF_WORK } from '../unit-of-work/unit-of-work';
import { AdvisoryJobLock } from './advisory-job-lock';
import { DatabaseProbe } from './database-probe';
import { createGuardedClient, GUARDED_CLIENT, type GuardedClient } from './guarded-client';
import type { ModelMap } from './model-map';
import { InProcessEventBus } from './outbox/in-process-event-bus';
import { PrismaOutboxRelay } from './outbox/prisma-outbox-relay';
import { PrismaOutboxWriterFactory } from './outbox/prisma-outbox-writer';
import { PrismaRoot } from './prisma-root';
import { PrismaService } from './prisma.service';
import { PrismaUnitOfWork } from './prisma-unit-of-work';

/** The generated map, checked against the shape the guard reads. */
const modelMap: ModelMap = MODEL_MAP;

/**
 * Persistence (platform persistence design, "P", 3.3, 5 to 7). Exports the guarded door for
 * modules (`PrismaService`), the `UnitOfWork` port, `DatabaseProbe`, and the implementations
 * of the event and scheduler ports (outbox writer factory, relay, bus, job lock); never the
 * base client (`PrismaRoot`) or the guarded client, so Nest cannot inject them elsewhere.
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaRoot,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new PrismaRoot(config),
    },
    {
      provide: GUARDED_CLIENT,
      inject: [PrismaRoot],
      useFactory: (root: PrismaRoot) => createGuardedClient(root, modelMap),
    },
    PrismaService,
    {
      provide: UNIT_OF_WORK,
      inject: [GUARDED_CLIENT],
      useFactory: (client: GuardedClient) => new PrismaUnitOfWork(client, modelMap),
    },
    {
      provide: DatabaseProbe,
      inject: [PrismaRoot],
      useFactory: (root: PrismaRoot) => new DatabaseProbe(root),
    },
    {
      provide: OUTBOX_WRITER_FACTORY,
      inject: [PrismaService, EventCatalogue, ID_GENERATOR, PERMISSION_KEY_LOOKUP],
      useFactory: (
        prisma: PrismaService,
        catalogue: EventCatalogue,
        ids: IdGenerator,
        permissionKeys: PermissionKeyLookup,
      ) => new PrismaOutboxWriterFactory(modelMap, prisma, catalogue, ids, permissionKeys),
    },
    { provide: EVENT_BUS, useClass: InProcessEventBus },
    {
      provide: OUTBOX_RELAY,
      inject: [PrismaRoot, MarketRegistry, MarketContextFactory, EVENT_BUS, CLOCK],
      useFactory: (
        root: PrismaRoot,
        markets: MarketRegistry,
        contexts: MarketContextFactory,
        bus: EventBus,
        clock: Clock,
      ) => new PrismaOutboxRelay(root, modelMap, markets, contexts, bus, clock),
    },
    {
      provide: JOB_LOCK,
      inject: [PrismaRoot],
      useFactory: (root: PrismaRoot) => new AdvisoryJobLock(root),
    },
  ],
  exports: [
    PrismaService,
    UNIT_OF_WORK,
    DatabaseProbe,
    OUTBOX_WRITER_FACTORY,
    EVENT_BUS,
    OUTBOX_RELAY,
    JOB_LOCK,
  ],
})
export class PersistenceModule {}
