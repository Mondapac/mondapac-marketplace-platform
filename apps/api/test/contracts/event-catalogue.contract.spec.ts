import { readdirSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { Module, type INestApplicationContext, type Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { EventDescription } from '@mondapac/shared-kernel';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import { CORE_MODULES } from '../../src/modules';
import { compareWithSnapshot, EventCatalogue } from '../../src/platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../src/platform/events/outbox-writer';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { JobRegistry } from '../../src/platform/scheduler/job-registry';
import { WorkerRuntime } from '../../src/platform/worker/worker-runtime';
import { testAppConfig } from '../support/test-config';

// The contracts test of platform persistence design 5.3 and the "one module graph" of 8: the
// catalogue is built from the booted application, in both roles, and compared with the
// checked-in snapshot of every event type and its fields. A new type fails until the snapshot
// changes (so the security review sees each one); a changed field list of an existing version
// fails with "publish a new version". To accept a new type, add its entry, as the failure
// prints it, to event-catalogue.snapshot.json.

const SNAPSHOT = path.join(__dirname, 'event-catalogue.snapshot.json');
const MODULES_DIR = path.join(__dirname, '../../src/modules');

async function boot(role: 'api' | 'worker'): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        config: testAppConfig({ APP_ROLE: role }),
        logDestination: pino.destination(devNull),
      }),
    ],
  }).compile();
  return moduleRef.init();
}

describe('event catalogue and registries of the booted application (P 5.3, 8)', () => {
  const graphs = new Map<'api' | 'worker', INestApplicationContext>();

  beforeAll(async () => {
    for (const role of ['api', 'worker'] as const) graphs.set(role, await boot(role));
  });

  afterAll(async () => {
    for (const graph of graphs.values()) await graph.close();
  });

  it('matches the checked-in snapshot of every event type and its fields', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as EventDescription[];
    const current = graphs.get('api')!.get(EventCatalogue).snapshot();

    expect({ problems: compareWithSnapshot(current, snapshot), current }).toEqual({
      problems: [],
      current,
    });
  });

  it('seals the catalogue and the job registry once the application has bootstrapped', () => {
    expect(graphs.get('api')!.get(EventCatalogue).sealed).toBe(true);
    expect(() => graphs.get('api')!.get(JobRegistry).register('identity', [])).toThrow(/sealed/);
  });

  it('builds the same catalogue and the same jobs in both roles', () => {
    const api = graphs.get('api')!;
    const worker = graphs.get('worker')!;

    expect(worker.get(EventCatalogue).snapshot()).toEqual(api.get(EventCatalogue).snapshot());
    expect(worker.get(JobRegistry).names()).toEqual(api.get(JobRegistry).names());
  });

  it('has the worker runtime in both graphs, started by neither', () => {
    for (const graph of graphs.values()) {
      expect(graph.get(WorkerRuntime)).toBeInstanceOf(WorkerRuntime);
    }
  });
});

describe("every module's outbox writer binding names its own folder (P 5.2)", () => {
  const folders = readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  /** The module name each OUTBOX_WRITER provider of a Nest module asks the factory for. */
  function boundNames(module: object): string[] {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module) ?? []) as Provider[];
    const names: string[] = [];
    const forModule = jest
      .spyOn(PrismaOutboxWriterFactory.prototype, 'forModule')
      .mockImplementation((name) => {
        names.push(name);
        return { append: () => Promise.resolve() };
      });
    try {
      for (const provider of providers) {
        if (
          typeof provider === 'object' &&
          'provide' in provider &&
          provider.provide === OUTBOX_WRITER
        ) {
          // The dependencies are not used until append; the spy records the name.
          (provider as { useFactory: (...deps: never[]) => unknown }).useFactory();
        }
      }
    } finally {
      forModule.mockRestore();
    }
    return names;
  }

  it('has one Nest module per folder, in CORE_MODULES', () => {
    expect(CORE_MODULES).toHaveLength(folders.length);
  });

  it.each(folders)('%s binds no writer, or one for itself', (folder) => {
    const module = CORE_MODULES.find(
      (candidate) => candidate.name.toLowerCase() === `${folder.replaceAll('-', '')}module`,
    );
    expect(module).toBeDefined();

    expect(boundNames(module!).every((name) => name === folder)).toBe(true);
  });

  it('identity binds its writer (PN6)', () => {
    const identity = CORE_MODULES.find((module) => module.name === 'IdentityModule')!;

    expect(boundNames(identity)).toEqual(['identity']);
  });
});

describe('a module reaches only its own outbox writer (P 5.2; security review of slice 1b, M1)', () => {
  /** Compiles the application graph plus one module whose provider injects `token`. */
  function compileWith(token: unknown): Promise<unknown> {
    @Module({ providers: [{ provide: 'ROGUE', inject: [token as symbol], useFactory: () => 1 }] })
    class RogueModule {}
    return Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ APP_ROLE: 'api' }),
          logDestination: pino.destination(devNull),
        }),
        RogueModule,
      ],
    }).compile();
  }

  it('cannot resolve the outbox writer factory: it is not a provider', async () => {
    await expect(compileWith(PrismaOutboxWriterFactory)).rejects.toThrow(
      /can't resolve dependencies/i,
    );
  });

  it("cannot resolve another module's writer (identity's OUTBOX_WRITER is not exported)", async () => {
    await expect(compileWith(OUTBOX_WRITER)).rejects.toThrow(/can't resolve dependencies/i);
  });

  it('exports, from no module of the graph, anything that hands out a writer by module name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ APP_ROLE: 'api' }),
          logDestination: pino.destination(devNull),
        }),
      ],
    }).compile();
    const container = (
      moduleRef as unknown as {
        container: { getModules(): Map<string, { metatype: object; exports: Set<unknown> }> };
      }
    ).container;
    const offenders: string[] = [];
    for (const nestModule of container.getModules().values()) {
      for (const token of nestModule.exports) {
        let instance: unknown;
        try {
          instance = moduleRef.get(token as symbol, { strict: false });
        } catch {
          continue; // A re-exported module, not a provider.
        }
        if (
          instance instanceof PrismaOutboxWriterFactory ||
          (typeof instance === 'object' && instance !== null && 'forModule' in instance)
        ) {
          offenders.push(`${(nestModule.metatype as { name: string }).name}:${String(token)}`);
        }
      }
    }
    await moduleRef.close();

    expect(offenders).toEqual([]);
  });

  it('identity resolves its own writer inside its module', async () => {
    const identity = CORE_MODULES.find((module) => module.name === 'IdentityModule')!;
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ APP_ROLE: 'api' }),
          logDestination: pino.destination(devNull),
        }),
      ],
    }).compile();

    expect(moduleRef.select(identity).get(OUTBOX_WRITER)).toHaveProperty('append');
    await moduleRef.close();
  });
});
