import { readdirSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { Module, type INestApplicationContext, type Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { AuditActionDescription } from '@mondapac/shared-kernel';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import { CORE_MODULES } from '../../src/modules';
import {
  AuditActionCatalogue,
  compareAuditCatalogueWithSnapshot,
} from '../../src/platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../src/platform/audit/audit-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { testAppConfig } from '../support/test-config';

// The contracts tests of docs/design/domain/platform-audit.md 16 for identity slice 6a:
// - the audit action catalogue of the booted application, in both roles, equals the checked-in
//   snapshot, so every new or changed action is read by the security-tester in the diff (3.2);
// - Ali's condition 1 on the 6a/6b split: no module binds an AUDIT_WRITER provider yet; the
//   writer is reachable from tests only. Identity slice 6b changes this expectation to
//   "identity only", with its own folder name, as the outbox writer's contract does;
// - a module can reach neither another module's writer nor a writer factory (PA 2).

const SNAPSHOT = path.join(__dirname, 'audit-action-catalogue.snapshot.json');
const SRC = path.join(__dirname, '../../src');

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

describe('audit action catalogue of the booted application (PA 3.2)', () => {
  const graphs = new Map<'api' | 'worker', INestApplicationContext>();

  beforeAll(async () => {
    for (const role of ['api', 'worker'] as const) graphs.set(role, await boot(role));
  });

  afterAll(async () => {
    for (const graph of graphs.values()) await graph.close();
  });

  it('matches the checked-in snapshot of every action and its shape', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as AuditActionDescription[];
    const current = graphs.get('api')!.get(AuditActionCatalogue).snapshot();

    expect({ problems: compareAuditCatalogueWithSnapshot(current, snapshot), current }).toEqual({
      problems: [],
      current,
    });
  });

  it('is sealed once the application has bootstrapped, and the same in both roles', () => {
    const api = graphs.get('api')!.get(AuditActionCatalogue);
    const worker = graphs.get('worker')!.get(AuditActionCatalogue);

    expect(api.sealed).toBe(true);
    expect(worker.sealed).toBe(true);
    expect(worker.snapshot()).toEqual(api.snapshot());
  });
});

describe('no module binds an audit writer in slice 6a (Ali, condition 1 on the split)', () => {
  /** Every provider token of a Nest module and of the modules it imports, depth first. */
  function providerTokens(module: object, seen = new Set<object>()): unknown[] {
    if (seen.has(module)) return [];
    seen.add(module);
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module) ?? []) as Provider[];
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ?? []) as unknown[];
    return [
      ...providers.map((provider) =>
        typeof provider === 'object' && 'provide' in provider ? provider.provide : provider,
      ),
      ...imports
        .filter((imported): imported is object => typeof imported === 'function')
        .flatMap((imported) => providerTokens(imported, seen)),
    ];
  }

  it('sees a binding when there is one, also in an imported submodule', () => {
    @Module({ providers: [PersistenceModule.auditWriterFor('alpha')] })
    class AlphaInfrastructureModule {}
    @Module({ imports: [AlphaInfrastructureModule] })
    class AlphaModule {}

    expect(providerTokens(AlphaModule)).toContain(AUDIT_WRITER);
  });

  it.each(CORE_MODULES.map((module) => [module.name, module] as const))(
    '%s provides no AUDIT_WRITER',
    (_name, module) => {
      expect(providerTokens(module)).not.toContain(AUDIT_WRITER);
    },
  );

  it('no module of the booted graph resolves an AUDIT_WRITER', async () => {
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
        container: {
          getModules(): Map<string, { metatype: object; providers: Map<unknown, unknown> }>;
        };
      }
    ).container;
    const binders = [...container.getModules().values()]
      .filter((nestModule) => nestModule.providers.has(AUDIT_WRITER))
      .map((nestModule) => (nestModule.metatype as { name: string }).name);
    await moduleRef.close();

    expect(binders).toEqual([]);
  });

  // The provider walk sees only `provide: AUDIT_WRITER`; a wrapping factory or a renamed token
  // would slip past it. So the source is scanned too: outside persistence.module.ts nothing in
  // src/ calls auditWriterFor or names the writer's implementation file.
  it('calls auditWriterFor nowhere in src/ and imports the writer implementation only in persistence.module.ts', () => {
    const DEFINITION = path.join('platform', 'persistence', 'persistence.module.ts');
    const IMPLEMENTATION = path.join('platform', 'persistence', 'audit', 'prisma-audit-writer.ts');
    const offenders: string[] = [];

    for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
        continue;
      }
      const file = path.relative(SRC, path.join(entry.parentPath, entry.name));
      if (file === DEFINITION || file === IMPLEMENTATION) continue;
      const code = readFileSync(path.join(SRC, file), 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/\/\/.*$/gm, '');
      if (/auditWriterFor|prisma-audit-writer|createAuditWriter/.test(code)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});

describe('a module reaches only its own audit writer (PA 2)', () => {
  function compileWith(...extra: object[]): Promise<unknown> {
    return Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ APP_ROLE: 'api' }),
          logDestination: pino.destination(devNull),
        }),
        ...(extra as never[]),
      ],
    }).compile();
  }

  it('cannot resolve an AUDIT_WRITER it did not bind: no module exports one', async () => {
    @Module({ providers: [{ provide: 'ROGUE', inject: [AUDIT_WRITER], useFactory: () => 1 }] })
    class RogueModule {}

    await expect(compileWith(RogueModule)).rejects.toThrow(/can't resolve dependencies/i);
  });

  it("cannot resolve another module's writer, even once one module binds it", async () => {
    @Module({ providers: [PersistenceModule.auditWriterFor('alpha')] })
    class AlphaModule {}
    @Module({ providers: [{ provide: 'ROGUE', inject: [AUDIT_WRITER], useFactory: () => 1 }] })
    class RogueModule {}

    await expect(compileWith(AlphaModule, RogueModule)).rejects.toThrow(
      /can't resolve dependencies/i,
    );
  });

  it('exports, from no module of the graph, anything that hands out a writer by owner', async () => {
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
          typeof instance === 'object' &&
          instance !== null &&
          ('record' in instance || 'forOwner' in instance || 'forModule' in instance)
        ) {
          offenders.push(`${(nestModule.metatype as { name: string }).name}:${String(token)}`);
        }
      }
    }
    await moduleRef.close();

    expect(offenders).toEqual([]);
  });

  it('refuses a malformed owner when the binding is declared', () => {
    for (const owner of ['platform', 'Identity', 'identity.role', 'platform.ai.x', '']) {
      expect(() => PersistenceModule.auditWriterFor(owner)).toThrow(/module name/);
    }
  });
});
