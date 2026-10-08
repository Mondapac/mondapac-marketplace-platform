import { readdirSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import { PERMISSION_KEY_LOOKUP } from '../../src/platform/events/outbox-writer';
import { PermissionRegistry } from '../../src/platform/authz';
import { isPermissionCatalogue } from '../../src/platform/authz/permission';
import { ROLE_SEED, type RoleSeed } from '../../src/modules/identity/application/ports/role-seed';
import { RoleSeedKeyError } from '../../src/modules/identity/application/roles/role-seed-keys';
import { CheckedInRoleSeed } from '../../src/modules/identity/infrastructure/seed/checked-in-role-seed';
import { testAppConfig } from '../support/test-config';

// The permission registry of the booted application (platform-foundations 6.1, guarantees 1
// to 5; identity design 5.5, 5.6; slice 8a-1): in both roles it holds exactly the catalogues the
// modules declare in `contracts/`, sealed once the application has bootstrapped; the audit
// writer and the outbox check keys against it (the NO_PERMISSION_KEYS swap); each module
// registers only its own catalogue, from its own module file; and a seed key the registry does
// not allow fails boot.

const SOURCE_ROOT = path.resolve(__dirname, '../../src');
const MODULES_DIR = path.join(SOURCE_ROOT, 'modules');

async function boot(role: 'api' | 'worker', seed?: RoleSeed): Promise<INestApplicationContext> {
  let builder = Test.createTestingModule({
    imports: [
      AppModule.register({
        config: testAppConfig({ APP_ROLE: role }),
        logDestination: pino.destination(devNull),
      }),
    ],
  });
  if (seed !== undefined) builder = builder.overrideProvider(ROLE_SEED).useValue(seed);
  return (await builder.compile()).init();
}

/** Every key declared by a catalogue exported from `modules/<m>/contracts/index.ts`. */
function declaredKeys(): string[] {
  const keys: string[] = [];
  for (const module of readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)) {
    let exported: Record<string, unknown>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- reads each catalogue
      exported = require(path.join(MODULES_DIR, module, 'contracts/index.ts')) as Record<
        string,
        unknown
      >;
    } catch {
      continue; // A module without contracts declares no key.
    }
    for (const catalogue of Object.values(exported).filter(isPermissionCatalogue)) {
      keys.push(...catalogue.declarations.map((d) => d.key));
    }
  }
  return keys.sort();
}

/** Every `.ts` source file below `directory`, without tests. */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) files.push(full);
  }
  return files;
}

describe('the permission registry of the booted application (PF 6.1; slice 8a-1)', () => {
  const graphs = new Map<'api' | 'worker', INestApplicationContext>();

  beforeAll(async () => {
    for (const role of ['api', 'worker'] as const) graphs.set(role, await boot(role));
  });

  afterAll(async () => {
    for (const graph of graphs.values()) await graph.close();
  });

  it('holds exactly the keys the modules declare in contracts/, sealed, in both roles', () => {
    const declared = declaredKeys();
    expect(declared.length).toBeGreaterThan(0);

    for (const graph of graphs.values()) {
      const registry = graph.get(PermissionRegistry);
      expect(registry.sealed).toBe(true);
      expect(
        registry
          .list()
          .map((d) => d.key)
          .sort(),
      ).toEqual(declared);
      expect(() => registry.register('identity', { module: 'identity' } as never)).toThrow(
        /sealed/,
      );
    }
  });

  it('is the key lookup of the audit writer and the outbox (the NO_PERMISSION_KEYS swap)', () => {
    for (const graph of graphs.values()) {
      const registry = graph.get(PermissionRegistry);
      expect(graph.get(PERMISSION_KEY_LOOKUP)).toBe(registry);
      expect(registry.isKnownPermissionKey('identity.seller-access.approve')).toBe(true);
      expect(registry.isKnownPermissionKey('identity.seller-access.approve-all')).toBe(false);
    }
  });

  it('accepts every key of the checked-in seed (the boot check ran and passed)', () => {
    const registry = graphs.get('api')!.get(PermissionRegistry);
    for (const role of new CheckedInRoleSeed().roles()) {
      for (const key of role.permissionKeys) {
        expect([key, registry.get(key)?.scope]).toEqual([key, role.scope]);
      }
    }
  });
});

describe('registerPermissions is called from a module file, with its own name (PF 6.1 row 1)', () => {
  it('names the folder of modules/<m>/<m>.module.ts, and nowhere else', () => {
    const calls: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const relative = path.relative(SOURCE_ROOT, file).split(path.sep).join('/');
      if (relative === 'platform/authz/permission-registry.ts') continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/registerPermissions\(\s*([^,)]*)/g)) {
        calls.push(`${relative} ${match[1]!.trim()}`);
      }
    }

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const [file, name] = call.split(' ');
      const owner = /^modules\/([^/]+)\/\1\.module\.ts$/.exec(file!)?.[1];
      expect(call).toEqual(`${file} '${owner}'`);
      expect(name).toBe(`'${owner}'`);
    }
  });
});

describe('the boot check of the seed keys (identity design 5.6)', () => {
  it('fails boot when a seed role names a key the registry does not declare', async () => {
    const roles = new CheckedInRoleSeed().roles();
    const broken: RoleSeed = {
      roles: () =>
        roles.map((role) =>
          role.seedCode === 'viewer'
            ? { ...role, permissionKeys: [...role.permissionKeys, 'identity.not-a-key'] }
            : role,
        ),
    };

    await expect(boot('api', broken)).rejects.toBeInstanceOf(RoleSeedKeyError);
  });
});
