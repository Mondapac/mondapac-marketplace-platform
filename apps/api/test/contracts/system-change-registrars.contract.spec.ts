import { readdirSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { Module, type INestApplicationContext, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import { SystemRequestsModule } from '../../src/modules/system-requests';
import { AREA_OWNERS } from '../../src/modules/system-requests/application/area-owners';
import {
  REVERTER_REGISTRY,
  type ReverterRegistry,
} from '../../src/modules/system-requests/application/reverter-registry';
import {
  createSystemChangeRegistrar,
  isSystemChangeRegistrar,
  type ChangeReviewArea,
  type SystemChangeApplier,
  type SystemChangeReverter,
} from '../../src/platform/change-review/change-review';
import { testAppConfig } from '../support/test-config';

// System requests binds a registering module's identity (Hassan's review of PR #904): a module
// registers its reverters and appliers only through its own registrar, created once in a file of
// that module and never exported from its barrel; system-requests refuses, while the application
// boots, a second registrar of one module, a kind outside the module's prefix, a kind registered
// twice and an area the module does not own. The booted application's kinds are pinned below
// (kind, module, area, mode, permission keys), so a changed area or key fails CI.

const SOURCE_ROOT = path.resolve(__dirname, '../../src');
const MODULES_DIR = path.join(SOURCE_ROOT, 'modules');
const PLATFORM_PORT = 'platform/change-review/change-review.ts';
/** The files that re-export the factory to the modules (system-requests' contracts). */
const RE_EXPORTS = new Set([
  'modules/system-requests/contracts/reverters.ts',
  'modules/system-requests/contracts/index.ts',
]);
const FACTORY = 'createSystemChangeRegistrar';

/** The modules that register kinds, each with an area it owns (for the impostor boots). */
const REGISTERING_MODULES: readonly (readonly [string, string])[] = [
  ['catalog', 'catalogue'],
  ['certification', 'certification'],
  ['commission-payouts', 'money'],
  ['identity', 'people'],
  ['settings', 'marketplace'],
  ['shipping', 'delivery'],
  // system-requests owns only review-policy, which the facade never takes: an impostor of it
  // can register nothing at all (see its own case below).
  ['system-requests', 'review-policy'],
  ['wallet', 'money'],
];

/** Every kind the booted application registers: kind, module, area, mode, permission keys. */
const REGISTERED_KINDS: readonly (readonly [string, string, string, string, string[] | null])[] = [
  ['catalog.attribute-create', 'catalog', 'catalogue', 'review', null],
  ['catalog.attribute-definition', 'catalog', 'catalogue', 'review', null],
  ['catalog.attribute-discard', 'catalog', 'catalogue', 'approval', ['catalog.attribute.edit']],
  [
    'catalog.attribute-restructure',
    'catalog',
    'catalogue',
    'approval',
    ['catalog.attribute.restructure'],
  ],
  ['catalog.category-attribute-links', 'catalog', 'catalogue', 'review', null],
  ['catalog.category-create', 'catalog', 'catalogue', 'review', null],
  ['catalog.category-details', 'catalog', 'catalogue', 'review', null],
  ['catalog.category-discard', 'catalog', 'catalogue', 'approval', ['catalog.category-tree.edit']],
  ['catalog.category-move', 'catalog', 'catalogue', 'review', null],
  [
    'catalog.category-products-move',
    'catalog',
    'catalogue',
    'approval',
    ['catalog.category-tree.restructure', 'catalog.product.approve'],
  ],
  ['catalog.category-reorder', 'catalog', 'catalogue', 'review', null],
  [
    'catalog.category-restructure',
    'catalog',
    'catalogue',
    'approval',
    ['catalog.category-tree.restructure'],
  ],
  ['catalog.feature-set-create', 'catalog', 'catalogue', 'approval', ['catalog.attribute.edit']],
  ['certification.claim-policy', 'certification', 'certification', 'review', null],
  ['certification.type-revision', 'certification', 'certification', 'review', null],
  ['commission-payouts.commission-rate', 'commission-payouts', 'money', 'review', null],
  ['commission-payouts.payout-terms', 'commission-payouts', 'money', 'review', null],
  ['identity.admin-invitation', 'identity', 'people', 'review', null],
  [
    'identity.admin-invitation-sensitive',
    'identity',
    'people',
    'approval',
    ['identity.admin-account.invite'],
  ],
  ['identity.admin-roles', 'identity', 'people', 'review', null],
  ['identity.admin-status', 'identity', 'people', 'review', null],
  ['identity.platform-role', 'identity', 'people', 'review', null],
  ['identity.platform-role-creation', 'identity', 'people', 'review', null],
  [
    'identity.platform-role-deletion',
    'identity',
    'people',
    'approval',
    ['identity.platform-role.delete'],
  ],
  ['settings.market-setting', 'settings', 'marketplace', 'review', null],
  ['shipping.delivery-settings', 'shipping', 'delivery', 'review', null],
  ['shipping.fleet-selection', 'shipping', 'delivery', 'review', null],
  ['shipping.fleet-selection-model', 'shipping', 'delivery', 'review', null],
  [
    'shipping.fleet-selection-model-create',
    'shipping',
    'delivery',
    'approval',
    ['shipping.fleet-selection.manage'],
  ],
  ['shipping.seller-delivery-methods', 'shipping', 'delivery', 'review', null],
  ['system-requests.policy-area', 'system-requests', 'review-policy', 'review', null],
  ['system-requests.review-due-days', 'system-requests', 'review-policy', 'review', null],
  ['wallet.market-status', 'wallet', 'money', 'review', null],
];

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) files.push(full);
  }
  return files;
}

const relativeOf = (file: string) => path.relative(SOURCE_ROOT, file).split(path.sep).join('/');

/** The `import { ... } from '...'` and `export { ... } from '...'` statements of a file. */
const STATEMENTS = /\b(import|export)\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|\*)\s*from\s*'([^']+)'/g;

const reverter: SystemChangeReverter = { revert: () => Promise.resolve('reverted') };
const applier: SystemChangeApplier = {
  apply: () => Promise.resolve('applied'),
  check: () => Promise.resolve('ok'),
};
const ROGUE_REVERTER = Symbol('ROGUE_REVERTER');
const ROGUE_APPLIER = Symbol('ROGUE_APPLIER');

/** A module that tries to register a kind with the given registrar's providers. */
function rogueModule(providers: Provider[]) {
  @Module({
    providers: [
      { provide: ROGUE_REVERTER, useValue: reverter },
      { provide: ROGUE_APPLIER, useValue: applier },
      ...providers,
    ],
  })
  class RogueModule {}
  return RogueModule;
}

async function boot(extra?: ReturnType<typeof rogueModule>): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        config: testAppConfig({ APP_ROLE: 'api' }),
        logDestination: pino.destination(devNull),
      }),
      ...(extra === undefined ? [] : [extra]),
    ],
  }).compile();
  return moduleRef.init();
}

describe('system change registrars are created by each module, once, under its own name', () => {
  it('names the folder of the module that creates it, once per module', () => {
    const calls: { file: string; module: string }[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const relative = relativeOf(file);
      if (relative === PLATFORM_PORT) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/createSystemChangeRegistrar\(\s*([^)]*)\)/g)) {
        calls.push({ file: relative, module: match[1]!.trim() });
      }
    }
    const modules = calls.map((call) => call.module);
    expect(new Set(modules).size).toBe(modules.length);
    expect(modules.sort()).toEqual(REGISTERING_MODULES.map(([name]) => `'${name}'`));
    for (const call of calls) {
      const name = call.module.replace(/^'(.*)'$/, '$1');
      expect(call.file.startsWith(`modules/${name}/`)).toBe(true);
    }
    // Nothing registers with a module name any more.
    for (const file of sourceFiles(SOURCE_ROOT)) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/registerSystemChange(Reverter|Applier)\(/);
    }
  });

  it('is imported under its own name only, and used only as a direct call with a literal', () => {
    const problems: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const relative = relativeOf(file);
      if (relative === PLATFORM_PORT) continue;
      // Comments may name the factory; only code counts.
      let text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const match of text.matchAll(STATEMENTS)) {
        const [statement, keyword, , specifiers, from] = match;
        const fromPort = from!.endsWith('change-review/change-review');
        const fromSystemRequests =
          /(^|\/)system-requests(\/contracts(\/index|\/reverters)?)?$/.test(from!);
        // A namespace import or `export *` of the port would hand out the factory under any name.
        if (specifiers!.startsWith('*') && fromPort && !RE_EXPORTS.has(relative)) {
          problems.push(`${relative}: ${statement}`);
        }
        if (!specifiers!.includes(FACTORY)) continue;
        if (!fromPort && !fromSystemRequests && !RE_EXPORTS.has(relative))
          problems.push(`${relative}: re-wrapped ${statement}`);
        if (new RegExp(`${FACTORY}\\s+as\\b`).test(specifiers!)) {
          problems.push(`${relative}: aliased ${statement}`);
        }
        if (keyword === 'export' && !RE_EXPORTS.has(relative)) {
          problems.push(`${relative}: re-exported ${statement}`);
        }
        text = text.replace(statement, '');
      }
      if (RE_EXPORTS.has(relative)) continue;
      // What is left: each use must be a direct call with a literal module name.
      const uses = text.match(new RegExp(`(?<![\\w$])${FACTORY}(?![\\w$])`, 'g'))?.length ?? 0;
      const calls = text.match(new RegExp(`(?<![\\w$.])${FACTORY}\\(\\s*'[a-z-]+'\\s*\\)`, 'g'));
      if (uses !== (calls?.length ?? 0)) problems.push(`${relative}: ${FACTORY} used indirectly`);
    }
    expect(problems).toEqual([]);
  });

  const barrels = readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [`${entry.name}/index`, `${entry.name}/contracts/index`])
    .filter((barrel) => {
      try {
        require.resolve(path.join(MODULES_DIR, barrel));
        return true;
      } catch {
        return false;
      }
    });

  it.each(barrels)('%s exports no registrar', (barrel) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loads each barrel
    const loaded = require(path.join(MODULES_DIR, barrel)) as Record<string, unknown>;
    expect(Object.values(loaded).filter(isSystemChangeRegistrar)).toEqual([]);
  });
});

describe('the kinds the booted application registers', () => {
  let app: INestApplicationContext;
  let registry: ReverterRegistry;

  beforeAll(async () => {
    app = await boot();
    registry = app
      .select(SystemRequestsModule)
      .get<ReverterRegistry>(REVERTER_REGISTRY, { strict: true });
  });

  afterAll(async () => {
    await app.close();
  });

  it('are exactly the pinned kinds, each with its module, area, mode and permission keys', () => {
    const registered = registry.kinds().map((kind) => {
      const found = registry.find(kind)!;
      return [
        kind,
        found.module,
        found.area,
        found.mode,
        found.mode === 'approval' ? [...found.permissions] : null,
      ];
    });
    expect(registered).toEqual(REGISTERED_KINDS);
  });

  it('come from exactly the eight registering modules, each in an area it owns', () => {
    const modules = new Set(registry.kinds().map((kind) => registry.find(kind)!.module));
    expect([...modules].sort()).toEqual(REGISTERING_MODULES.map(([name]) => name));
    for (const kind of registry.kinds()) {
      const found = registry.find(kind)!;
      expect(kind.startsWith(`${found.module}.`)).toBe(true);
      expect(AREA_OWNERS[found.area]).toContain(found.module);
    }
  });
});

describe('a registration that does not belong to its module fails boot', () => {
  // Which of the two registers first depends on Nest's provider order, so the error is checked
  // for both creation sites, in either order.
  it.each(REGISTERING_MODULES.filter(([name]) => name !== 'system-requests'))(
    'refuses a second registrar of %s, naming where both were created',
    async (name, area) => {
      const impostor = createSystemChangeRegistrar(name);
      const failed = boot(
        rogueModule([impostor.reverter(`${name}.rogue`, area as ChangeReviewArea, ROGUE_REVERTER)]),
      );
      const error = await failed.then(
        () => null,
        (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
      );
      expect(error).toMatch(new RegExp(`^Module "${name}" has a second registrar`));
      expect(error).toMatch(/\(first created at .+, second at .+\)$/);
      expect(error).toContain(`modules/${name}/`);
      expect(error).toContain('system-change-registrars.contract.spec.ts');
    },
  );

  it('refuses an impostor of system-requests, which can register in no area', async () => {
    const impostor = createSystemChangeRegistrar('system-requests');
    // review-policy is refused by the facade; any other area is not system-requests' own, and
    // when system-requests registered first the impostor is a second registrar.
    for (const area of ['review-policy', 'people'] as const) {
      await expect(
        boot(
          rogueModule([impostor.reverter('system-requests.rogue', area as never, ROGUE_REVERTER)]),
        ),
      ).rejects.toThrow(/second registrar|does not own|is not a reviewed area/);
    }
  });

  it('refuses a module registering in an area it does not own', async () => {
    const rogue = createSystemChangeRegistrar('rogue');
    await expect(
      boot(rogueModule([rogue.reverter('rogue.payout-rate', 'money', ROGUE_REVERTER)])),
    ).rejects.toThrow(/does not own/);
    const applierOnly = createSystemChangeRegistrar('rogue-applier');
    await expect(
      boot(
        rogueModule([
          applierOnly.applier(
            'rogue-applier.role-delete',
            'people',
            'identity.platform-role.edit',
            ROGUE_APPLIER,
          ),
        ]),
      ),
    ).rejects.toThrow(/does not own/);
  });

  it('refuses a kind outside the module prefix before the module is even declared', () => {
    const rogue = createSystemChangeRegistrar('rogue-prefix');
    expect(() => rogue.reverter('settings.market-setting', 'marketplace', ROGUE_REVERTER)).toThrow(
      /its kinds start with "rogue-prefix."/,
    );
  });
});
