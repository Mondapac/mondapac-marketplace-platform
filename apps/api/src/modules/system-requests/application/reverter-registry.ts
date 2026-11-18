import type {
  SystemChangeReverter,
  SystemChangeReverters,
} from '../../../platform/change-review/change-review';
import { isPolicyArea, type ReviewArea } from '../domain/areas';
import { isSubjectKind } from '../domain/request';

/** A registered kind: its reverter and the one area its changes are reviewed in. */
export interface RegisteredKind {
  readonly reverter: SystemChangeReverter;
  readonly area: ReviewArea;
}

/** What system-requests itself reads from the registry. */
export interface ReverterLookup {
  find(subjectKind: string): RegisteredKind | null;
}

/** The review policy's own kinds: the only ones in the area `review-policy`. */
const OWN_MODULE = 'system-requests';

/** A registration refused at boot: a malformed kind, another module's kind, a duplicate, or late. */
export class ReverterRegistryError extends Error {
  override readonly name = 'ReverterRegistryError';
}

/**
 * The reverters of every reviewed subject kind. Modules register theirs while the application
 * starts (`registerSystemChangeReverter`); the module seals the registry once it has
 * bootstrapped, so nothing registers later. A kind's first segment is the registering module.
 */
export class ReverterRegistry implements ReverterLookup {
  readonly #reverters = new Map<string, RegisteredKind>();
  #sealed = false;

  /** What other modules get: `register` only, bound to this registry. */
  readonly facade: SystemChangeReverters = Object.freeze({
    register: (
      module: string,
      subjectKind: string,
      area: Parameters<SystemChangeReverters['register']>[2],
      reverter: SystemChangeReverter,
    ) => {
      if (!isPolicyArea(area)) {
        throw new ReverterRegistryError(`${JSON.stringify(area)} is not a reviewed area`);
      }
      this.register(module, subjectKind, area, reverter);
    },
  });

  /** Registers a kind; `review-policy` only for system-requests' own kinds. */
  register(
    module: string,
    subjectKind: string,
    area: ReviewArea,
    reverter: SystemChangeReverter,
  ): void {
    if (this.#sealed) throw new ReverterRegistryError('The reverter registry is sealed');
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
    if (area === 'review-policy' && module !== OWN_MODULE) {
      throw new ReverterRegistryError(`Only ${OWN_MODULE} registers in the review-policy area`);
    }
    if (typeof reverter?.revert !== 'function') {
      throw new ReverterRegistryError(`The reverter of "${subjectKind}" has no revert method`);
    }
    if (reverter.describe !== undefined && typeof reverter.describe !== 'function') {
      throw new ReverterRegistryError(`The reverter of "${subjectKind}" has a bad describe`);
    }
    this.#reverters.set(subjectKind, Object.freeze({ reverter, area }));
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
