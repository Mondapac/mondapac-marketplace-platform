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

// The contracts tests of docs/design/domain/platform-audit.md 16 (identity slices 6a and 6b):
// - the audit action catalogue of the booted application, in both roles, equals the checked-in
//   snapshot, so every new or changed action is read by the security-tester in the diff (3.2);
// - Ali's condition 1 on the 6a/6b split, as 6b changes it: only the modules of AUDITING_MODULES
//   bind an AUDIT_WRITER provider, each its own (identity since 6b; pricing since its slice 1
//   part 3b, whose audited actions are design 8 of its approved G2);
// - Hassan L4 (carried from 6a): each registration of actions and each writer binding names the
//   folder it is declared in: `<m>` only in src/modules/<m>/<m>.module.ts, and
//   `platform.<component>` only in src/platform/<component>/. Checked in the source and in the
//   booted graph, for `registerAuditActions` and `auditWriterFor` alike;
// - a module can reach neither another module's writer nor a writer factory (PA 2).

const SNAPSHOT = path.join(__dirname, 'audit-action-catalogue.snapshot.json');

/**
 * The Nest modules that bind their own audit writer and register their actions. A module joins
 * this list only with the audited actions its approved design names (pricing: design 8).
 */
const AUDITING_MODULES = ['IdentityModule', 'PricingModule'] as const;
const SRC = path.join(__dirname, '../../src');

const foldersOf = (dir: string) =>
  readdirSync(path.join(SRC, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
const MODULE_FOLDERS = foldersOf('modules');
const PLATFORM_FOLDERS = foldersOf('platform');

/**
 * The owner a Nest module may register actions and bind a writer for: its module folder
 * (`IdentityModule` is `identity`), or `platform.<component>` for the Nest module of
 * src/platform/<component>/ (`AuditModule` is `platform.audit`); null for any other.
 */
function ownerOfNestModule(name: string): string | null {
  const lower = name.toLowerCase();
  const named = (folder: string) => `${folder.replaceAll('-', '')}module` === lower;
  const module = MODULE_FOLDERS.find(named);
  if (module !== undefined) return module;
  const component = PLATFORM_FOLDERS.find(named);
  return component === undefined ? null : `platform.${component}`;
}

/** The owner a source file may name: `<m>` in modules/<m>/<m>.module.ts, `platform.<c>` in platform/<c>/. */
function ownerOfFile(file: string): string | null {
  const [top, folder, name] = file.split(path.sep);
  if (top === 'modules' && folder !== undefined && name === `${folder}.module.ts`) return folder;
  if (top === 'platform' && folder !== undefined && name !== undefined) return `platform.${folder}`;
  return null;
}

function apiGraph() {
  return Test.createTestingModule({
    imports: [
      AppModule.register({
        config: testAppConfig({ APP_ROLE: 'api' }),
        logDestination: pino.destination(devNull),
      }),
    ],
  }).compile();
}

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

interface NestModuleView {
  readonly metatype: { readonly name: string };
  readonly providers: Map<unknown, { readonly instance: unknown }>;
  readonly exports: Set<unknown>;
}

/** The Nest modules of a compiled graph, with their provider wrappers. */
function nestModulesOf(moduleRef: unknown): NestModuleView[] {
  const container = (moduleRef as { container: { getModules(): Map<string, NestModuleView> } })
    .container;
  return [...container.getModules().values()];
}

/** The owner a bound writer was built for (the writer keeps it to check each entry). */
const ownerOfWriter = (writer: unknown) => (writer as { owner?: unknown }).owner;

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

  it("holds identity's actions of slices 6b, 8a-1 and 7b (PA 5)", () => {
    const actions = graphs
      .get('api')!
      .get(AuditActionCatalogue)
      .snapshot()
      .map((entry) => entry.action)
      .filter((action) => action.startsWith('identity.'));

    expect(actions).toEqual([
      'identity.account-role.assigned',
      'identity.admin-session.opened',
      'identity.invitation.accepted',
      'identity.invitation.issued',
      'identity.role.seed-applied',
      'identity.role.seeded',
      'identity.second-factor.activated',
      'identity.second-factor.recovery-codes-regenerated',
      'identity.second-factor.replaced',
      'identity.second-factor.reset',
      'identity.seller-access.founded',
      'identity.seller-member.added',
    ]);
  });

  it('names, for every action, an owner whose folder exists (Hassan L4)', () => {
    const catalogue = graphs.get('api')!.get(AuditActionCatalogue);
    const unknown = catalogue
      .snapshot()
      .map((entry) => catalogue.get(entry.action)!)
      .filter((definition) => {
        const platform = /^platform\.(.+)$/.exec(definition.owner);
        return platform === null
          ? !MODULE_FOLDERS.includes(definition.owner)
          : !PLATFORM_FOLDERS.includes(platform[1]!);
      })
      .map((definition) => definition.action);

    expect(unknown).toEqual([]);
  });
});

describe('only the auditing modules bind an audit writer, each its own (Ali, condition 1, as 6b changes it)', () => {
  /**
   * Every provider token of a Nest module and of the submodules it imports, depth first. An
   * imported bounded-context module (`sellers` imports `identity` for its facade) is its own
   * case, not a submodule, so the walk does not enter it.
   */
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
        .filter((imported) => !(CORE_MODULES as readonly object[]).includes(imported))
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
    '%s provides an AUDIT_WRITER only if it is an auditing module',
    (name, module) => {
      expect(providerTokens(module).includes(AUDIT_WRITER)).toBe(
        (AUDITING_MODULES as readonly string[]).includes(name),
      );
    },
  );

  it('in the booted graph, only the auditing modules resolve an AUDIT_WRITER, each bound to its own folder', async () => {
    const moduleRef = await apiGraph();
    const binders = nestModulesOf(moduleRef)
      .filter((nestModule) => nestModule.providers.has(AUDIT_WRITER))
      .map((nestModule) => [
        nestModule.metatype.name,
        ownerOfWriter(nestModule.providers.get(AUDIT_WRITER)!.instance),
      ]);
    await moduleRef.close();

    expect(binders.sort()).toEqual([
      ['IdentityModule', 'identity'],
      ['PricingModule', 'pricing'],
    ]);
  });

  it('binds every writer and registers every action list in the Nest module of its owner (Hassan L4)', async () => {
    const moduleRef = await apiGraph();
    const found: { module: string; kind: string; owner: unknown; allowed: string | null }[] = [];
    for (const nestModule of nestModulesOf(moduleRef)) {
      const module = nestModule.metatype.name;
      const allowed = ownerOfNestModule(module);
      for (const [token, wrapper] of nestModule.providers) {
        if (typeof token === 'symbol' && token.description?.startsWith('audit-actions:') === true) {
          // registerAuditActions' provider answers the owner it registered.
          found.push({ module, kind: 'actions', owner: wrapper.instance, allowed });
        } else if (token === AUDIT_WRITER) {
          found.push({ module, kind: 'writer', owner: ownerOfWriter(wrapper.instance), allowed });
        }
      }
    }
    await moduleRef.close();

    expect(found.map((entry) => [entry.module, entry.kind]).sort()).toEqual([
      ['IdentityModule', 'actions'],
      ['IdentityModule', 'writer'],
      ['PricingModule', 'actions'],
      ['PricingModule', 'writer'],
    ]);
    expect(found.filter((entry) => entry.owner !== entry.allowed)).toEqual([]);
  });

  it('maps Nest modules to the owners they may name', () => {
    expect(ownerOfNestModule('IdentityModule')).toBe('identity');
    expect(ownerOfNestModule('CommissionPayoutsModule')).toBe('commission-payouts');
    expect(ownerOfNestModule('AuditModule')).toBe('platform.audit');
    expect(ownerOfNestModule('AppModule')).toBeNull();
    expect(ownerOfFile(path.join('modules', 'identity', 'identity.module.ts'))).toBe('identity');
    expect(ownerOfFile(path.join('modules', 'identity', 'domain', 'audit', 'index.ts'))).toBeNull();
    expect(ownerOfFile(path.join('platform', 'ai', 'ai.module.ts'))).toBe('platform.ai');
    expect(ownerOfFile('app.module.ts')).toBeNull();
  });

  // The provider walks see only the tokens; a wrapping factory or a renamed token would slip
  // past them. So the source is scanned too (Hassan L4): outside their definitions,
  // `registerAuditActions('<owner>', ...)` and `PersistenceModule.auditWriterFor('<owner>')`
  // appear at most once per file, as a call with a literal owner that is the file's own
  // folder's, besides an import of the name. Nothing else names the writer's implementation.
  it('calls registerAuditActions and auditWriterFor only with the owner of the folder they are in (Hassan L4)', () => {
    const WRITER_DEFINITION = path.join('platform', 'persistence', 'persistence.module.ts');
    const ACTIONS_DEFINITION = path.join('platform', 'audit', 'audit-action-catalogue.ts');
    const IMPLEMENTATION = path.join('platform', 'persistence', 'audit', 'prisma-audit-writer.ts');
    const HELPERS = [
      {
        name: 'auditWriterFor',
        definition: WRITER_DEFINITION,
        call: /(?<![.\w])PersistenceModule\.auditWriterFor\('([^']*)'\)/g,
      },
      {
        name: 'registerAuditActions',
        definition: ACTIONS_DEFINITION,
        call: /(?<![.\w])registerAuditActions\('([^']*)',/g,
      },
    ];
    const offenders: string[] = [];
    const calls: string[] = [];

    for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
        continue;
      }
      const file = path.relative(SRC, path.join(entry.parentPath, entry.name));
      if (file === IMPLEMENTATION) continue;
      // Comments may name the helpers (their own documentation does); code may not.
      const code = readFileSync(path.join(SRC, file), 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/\/\/.*$/gm, '');
      if (file !== WRITER_DEFINITION && /prisma-audit-writer|createAuditWriter/.test(code)) {
        offenders.push(`${file}: names the writer's implementation`);
      }
      for (const helper of HELPERS) {
        if (file === helper.definition) continue;
        const uses = code.split(helper.name).length - 1;
        if (uses === 0) continue;
        const called = [...code.matchAll(helper.call)];
        const imported = new RegExp(`import\\s*\\{[^}]*\\b${helper.name}\\b[^}]*\\}\\s*from`).test(
          code,
        )
          ? 1
          : 0;
        if (called.length > 1 || called.length + imported !== uses) {
          offenders.push(
            `${file}: ${helper.name} is used other than as one call with a literal owner`,
          );
          continue;
        }
        for (const [, owner] of called) {
          calls.push(`${file}: ${helper.name}('${owner}')`);
          if (owner !== ownerOfFile(file)) {
            offenders.push(`${file}: ${helper.name}('${owner}') does not name its own folder`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(calls.sort()).toEqual([
      `${path.join('modules', 'identity', 'identity.module.ts')}: auditWriterFor('identity')`,
      `${path.join('modules', 'identity', 'identity.module.ts')}: registerAuditActions('identity')`,
      `${path.join('modules', 'pricing', 'pricing.module.ts')}: auditWriterFor('pricing')`,
      `${path.join('modules', 'pricing', 'pricing.module.ts')}: registerAuditActions('pricing')`,
    ]);
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
    const moduleRef = await apiGraph();
    const offenders: string[] = [];
    for (const nestModule of nestModulesOf(moduleRef)) {
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
          offenders.push(`${nestModule.metatype.name}:${String(token)}`);
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
