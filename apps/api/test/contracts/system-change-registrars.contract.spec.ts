import { readdirSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { Module, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import {
  createSystemChangeRegistrar,
  isSystemChangeRegistrar,
  type SystemChangeApplier,
  type SystemChangeReverter,
} from '../../src/platform/change-review/change-review';
import { testAppConfig } from '../support/test-config';

// System requests binds a registering module's identity (Hassan's review of PR #904): a module
// registers its reverters and appliers only through its own registrar, created once in a file of
// that module and never exported from its barrel; system-requests refuses, while the application
// boots, a second registrar of one module, a kind outside the module's prefix, a kind registered
// twice and an area the module does not own.

const SOURCE_ROOT = path.resolve(__dirname, '../../src');
const MODULES_DIR = path.join(SOURCE_ROOT, 'modules');
const PLATFORM_PORT = 'platform/change-review/change-review.ts';

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) files.push(full);
  }
  return files;
}

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

async function boot(extra?: ReturnType<typeof rogueModule>) {
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
      const relative = path.relative(SOURCE_ROOT, file).split(path.sep).join('/');
      if (relative === PLATFORM_PORT) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/createSystemChangeRegistrar\(\s*([^)]*)\)/g)) {
        calls.push({ file: relative, module: match[1]!.trim() });
      }
    }
    const modules = calls.map((call) => call.module);
    expect(new Set(modules).size).toBe(modules.length);
    expect(modules.sort()).toEqual([
      "'catalog'",
      "'certification'",
      "'commission-payouts'",
      "'identity'",
      "'settings'",
      "'shipping'",
      "'system-requests'",
      "'wallet'",
    ]);
    for (const call of calls) {
      const name = call.module.replace(/^'(.*)'$/, '$1');
      expect(call.file.startsWith(`modules/${name}/`)).toBe(true);
    }
    // Nothing registers with a module name any more.
    for (const file of sourceFiles(SOURCE_ROOT)) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/registerSystemChange(Reverter|Applier)\(/);
    }
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

describe('a registration that does not belong to its module fails boot', () => {
  it('refuses a second registrar of a module that already registers (identity)', async () => {
    const impostor = createSystemChangeRegistrar('identity');
    await expect(
      boot(rogueModule([impostor.reverter('identity.rogue', 'people', ROGUE_REVERTER)])),
    ).rejects.toThrow(/second registrar/);
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
