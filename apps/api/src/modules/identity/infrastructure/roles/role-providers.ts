import type { FactoryProvider } from '@nestjs/common';
import { PermissionRegistry } from '../../../../platform/authz';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  EFFECTIVE_KEY_RESOLVER,
  effectiveKeysOf,
  registryView,
  type EffectiveKeyResolver,
} from '../../application/access/effective-keys';
import { ROLE_GRANT_READER, type RoleGrantReader } from '../../application/ports/role-grant-reader';
import { ROLE_SEED, type RoleSeed } from '../../application/ports/role-seed';
import { checkRoleSeedKeys } from '../../application/roles/role-seed-keys';
import { PrismaRoleGrantReader } from './prisma-role-grant-reader';

/** Token of the boot check of the seed's keys (identity design 5.6). */
export const ROLE_SEED_KEY_CHECK = Symbol('identity:role-seed-key-check');

/**
 * The permission path of slice 8a-1 (identity design 5.2, 5.5, 5.6, 8.7):
 *
 * - the grant read, on identity's role tables (here because only `infrastructure/` may reach
 *   `PrismaService`);
 * - the one effective-key resolver of the process (R-3 review N-1): `effectiveKeysOf` over the
 *   permission registry, which the `AuthorisationCheck`, the reviewer read and the actor summary
 *   all inject through `EFFECTIVE_KEY_RESOLVER`, so the gate and the reviewer rule cannot be
 *   bound apart;
 * - the boot check of the seed's keys: once the registry is sealed, a seed key that is unknown,
 *   of the wrong scope or protected fails boot, in both roles.
 */
export const roleProviders: readonly FactoryProvider[] = [
  {
    provide: ROLE_GRANT_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RoleGrantReader => new PrismaRoleGrantReader(prisma),
  },
  {
    provide: EFFECTIVE_KEY_RESOLVER,
    inject: [PermissionRegistry],
    useFactory: (registry: PermissionRegistry): EffectiveKeyResolver => {
      const view = registryView(registry);
      return Object.freeze((subject: Parameters<EffectiveKeyResolver>[0]) =>
        effectiveKeysOf(subject, view),
      );
    },
  },
  {
    provide: ROLE_SEED_KEY_CHECK,
    inject: [PermissionRegistry, ROLE_SEED],
    useFactory: (registry: PermissionRegistry, seed: RoleSeed) => {
      registry.whenSealed((catalogue) => checkRoleSeedKeys(seed.roles(), catalogue));
      return 'identity.role-seed-keys';
    },
  },
];
