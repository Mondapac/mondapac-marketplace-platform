import {
  effectiveKeysOf,
  registryView,
  type EffectiveKeyResolver,
} from '../../src/modules/identity/application/access/effective-keys';
import { CATALOG_PERMISSIONS } from '../../src/modules/catalog/contracts/permissions';
import { IDENTITY_PERMISSIONS } from '../../src/modules/identity/contracts/permissions';
import { INVENTORY_PERMISSIONS } from '../../src/modules/inventory/contracts/permissions';
import { PRICING_PERMISSIONS } from '../../src/modules/pricing/contracts/permissions';
import { SELLERS_PERMISSIONS } from '../../src/modules/sellers/contracts/permissions';
import { PermissionRegistry } from '../../src/platform/authz/permission-registry';

/**
 * The permission registry as the application builds it (identity slice 8a-1): the real
 * catalogues of every module that declares keys, pushed and sealed. For unit tests that need
 * "the real registry" without booting the application; the contracts test checks that the
 * booted registry holds exactly these catalogues.
 */
export function realPermissionRegistry(): PermissionRegistry {
  const registry = new PermissionRegistry();
  registry.register('identity', IDENTITY_PERMISSIONS);
  registry.register('sellers', SELLERS_PERMISSIONS);
  registry.register('catalog', CATALOG_PERMISSIONS);
  registry.register('inventory', INVENTORY_PERMISSIONS);
  registry.register('pricing', PRICING_PERMISSIONS);
  registry.seal();
  return registry;
}

/** The resolver `EFFECTIVE_KEY_RESOLVER` binds, over {@link realPermissionRegistry}. */
export function realEffectiveKeys(
  registry: PermissionRegistry = realPermissionRegistry(),
): EffectiveKeyResolver {
  const view = registryView(registry);
  return (subject) => effectiveKeysOf(subject, view);
}
