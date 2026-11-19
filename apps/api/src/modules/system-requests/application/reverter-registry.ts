import {
  isSystemChangeRegistrar,
  type SystemChangeApplier,
  type SystemChangeRegistrar,
  type SystemChangeReverter,
  type SystemChangeReverters,
} from '../../../platform/change-review/change-review';
import { isDeclarablePermissionKey, type PermissionKey } from '../../../platform/authz';
import { isPolicyArea, type ReviewArea } from '../domain/areas';
import { isSubjectKind } from '../domain/request';
import { AREA_OWNERS, type AreaOwners } from './area-owners';

/** How a kind's requests work: reviewed after the change is live, or applied once approved. */
export type RequestMode = 'review' | 'approval';

/** What both a reverter and an applier may answer about their subjects. */
export type SubjectHooks = Pick<SystemChangeReverter, 'isInterested' | 'describe'>;

/**
 * A registered kind and the one area its changes are reviewed in: a reverter (changes applied at
 * once, reviewed after) or an applier (actions applied only once approved).
 */
export type RegisteredKind =
  | {
      readonly mode: 'review';
      readonly area: ReviewArea;
      readonly reverter: SystemChangeReverter;
      readonly applier: null;
      readonly hooks: SubjectHooks;
    }
  | {
      readonly mode: 'approval';
      readonly area: ReviewArea;
      readonly reverter: null;
      readonly applier: SystemChangeApplier;
      /** The permission keys the approving admin must all hold, checked by system-requests itself. */
      readonly permissions: readonly [PermissionKey, ...PermissionKey[]];
      readonly hooks: SubjectHooks;
    };

/** What system-requests itself reads from the registry. */
export interface ReverterLookup {
  find(subjectKind: string): RegisteredKind | null;
}

/**
 * A registration refused at boot: no registrar, a second registrar of one module, a malformed
 * kind, another module's kind, an area the module does not own, a duplicate, or late.
 */
export class ReverterRegistryError extends Error {
  override readonly name = 'ReverterRegistryError';
}

/**
 * The reverters of every reviewed subject kind. Modules register theirs while the application
 * starts, through their own registrar (`createSystemChangeRegistrar`); the module seals the
 * registry once it has bootstrapped, so nothing registers later. The registering module is the
 * registrar's, never a name the caller passes: one registrar per module name, a kind's first
 * segment is that module, and the module must own the area ({@link AREA_OWNERS}).
 */
export class ReverterRegistry implements ReverterLookup {
  readonly #reverters = new Map<string, RegisteredKind>();
  /** The registrar that holds each module name: the first one seen; another is refused. */
  readonly #registrars = new Map<string, SystemChangeRegistrar>();
  readonly #owners: AreaOwners;
  #sealed = false;

  /** `owners` is {@link AREA_OWNERS} in the application; a spec may pass its own. */
  constructor(owners: AreaOwners = AREA_OWNERS) {
    this.#owners = owners;
  }

  /** What other modules get: `register` only, bound to this registry. */
  readonly facade: SystemChangeReverters = Object.freeze({
    register: (
      registrar: SystemChangeRegistrar,
      subjectKind: string,
      area: Parameters<SystemChangeReverters['register']>[2],
      reverter: SystemChangeReverter,
    ) => {
      if (!isPolicyArea(area)) {
        throw new ReverterRegistryError(`${JSON.stringify(area)} is not a reviewed area`);
      }
      this.register(registrar, subjectKind, area, reverter);
    },
    registerApplier: (
      registrar: SystemChangeRegistrar,
      subjectKind: string,
      area: Parameters<SystemChangeReverters['registerApplier']>[2],
      permission: string | readonly string[],
      applier: SystemChangeApplier,
    ) => {
      if (!isPolicyArea(area)) {
        throw new ReverterRegistryError(`${JSON.stringify(area)} is not a reviewed area`);
      }
      this.registerApplier(registrar, subjectKind, area, permission, applier);
    },
  });

  /** Registers a kind; `review-policy` only for system-requests' own kinds. */
  register(
    registrar: SystemChangeRegistrar,
    subjectKind: string,
    area: ReviewArea,
    reverter: SystemChangeReverter,
  ): void {
    this.#checkKind(registrar, subjectKind, area);
    if (typeof reverter?.revert !== 'function') {
      throw new ReverterRegistryError(`The reverter of "${subjectKind}" has no revert method`);
    }
    if (reverter.describe !== undefined && typeof reverter.describe !== 'function') {
      throw new ReverterRegistryError(`The reverter of "${subjectKind}" has a bad describe`);
    }
    this.#reverters.set(
      subjectKind,
      Object.freeze({ mode: 'review', area, reverter, applier: null, hooks: reverter }),
    );
  }

  /**
   * Registers a kind whose actions wait for approval: the permission key (or keys, all required)
   * the approving admin must hold (checked by system-requests itself before the approval's unit), and an applier with
   * `apply` and `check`.
   */
  registerApplier(
    registrar: SystemChangeRegistrar,
    subjectKind: string,
    area: ReviewArea,
    permission: string | readonly string[],
    applier: SystemChangeApplier,
  ): void {
    this.#checkKind(registrar, subjectKind, area);
    if (area === 'review-policy') {
      throw new ReverterRegistryError('The review policy has no actions that wait for approval');
    }
    const keys: readonly unknown[] = typeof permission === 'string' ? [permission] : permission;
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every(isDeclarablePermissionKey)) {
      throw new ReverterRegistryError(`The applier of "${subjectKind}" needs its permission keys`);
    }
    const permissions = Object.freeze([...new Set(keys)]) as unknown as readonly [
      PermissionKey,
      ...PermissionKey[],
    ];
    if (typeof applier?.apply !== 'function' || typeof applier.check !== 'function') {
      throw new ReverterRegistryError(`The applier of "${subjectKind}" needs apply and check`);
    }
    if (applier.describe !== undefined && typeof applier.describe !== 'function') {
      throw new ReverterRegistryError(`The applier of "${subjectKind}" has a bad describe`);
    }
    this.#reverters.set(
      subjectKind,
      Object.freeze({
        mode: 'approval',
        area,
        reverter: null,
        applier,
        permissions,
        hooks: applier,
      }),
    );
  }

  #checkKind(registrar: SystemChangeRegistrar, subjectKind: string, area: ReviewArea): void {
    if (this.#sealed) throw new ReverterRegistryError('The reverter registry is sealed');
    if (!isSystemChangeRegistrar(registrar)) {
      throw new ReverterRegistryError(
        `"${String(subjectKind)}" is not registered through a module's registrar`,
      );
    }
    const { module } = registrar;
    const holder = this.#registrars.get(module);
    if (holder !== undefined && holder !== registrar) {
      throw new ReverterRegistryError(
        `Module "${module}" has a second registrar: a module creates its registrar once`,
      );
    }
    if (!isSubjectKind(subjectKind)) {
      throw new ReverterRegistryError(`${JSON.stringify(subjectKind)} is not a subject kind`);
    }
    if (subjectKind.split('.')[0] !== module) {
      throw new ReverterRegistryError(
        `Module "${module}" cannot register "${subjectKind}": a kind starts with its module`,
      );
    }
    if (this.#reverters.has(subjectKind)) {
      throw new ReverterRegistryError(`The subject kind "${subjectKind}" is registered twice`);
    }
    if (!(this.#owners[area] ?? []).includes(module)) {
      throw new ReverterRegistryError(
        `Module "${module}" cannot register "${subjectKind}" in area "${area}": it does not own it`,
      );
    }
    this.#registrars.set(module, registrar);
  }

  find(subjectKind: string): RegisteredKind | null {
    return this.#reverters.get(subjectKind) ?? null;
  }

  seal(): void {
    this.#sealed = true;
  }

  kinds(): readonly string[] {
    return [...this.#reverters.keys()].sort();
  }
}
