import type { SystemChangeReverter, SystemChangeReverters } from '../contracts/reverters';
import { isSubjectKind } from '../domain/request';

/** A registration refused at boot: a malformed kind, another module's kind, a duplicate, or late. */
export class ReverterRegistryError extends Error {
  override readonly name = 'ReverterRegistryError';
}

/**
 * The reverters of every reviewed subject kind. Modules register theirs while the application
 * starts (`registerSystemChangeReverter`); the module seals the registry once it has
 * bootstrapped, so nothing registers later. A kind's first segment is the registering module.
 */
export class ReverterRegistry implements SystemChangeReverters {
  readonly #reverters = new Map<string, SystemChangeReverter>();
  #sealed = false;

  register(module: string, subjectKind: string, reverter: SystemChangeReverter): void {
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
    if (typeof reverter?.revert !== 'function') {
      throw new ReverterRegistryError(`The reverter of "${subjectKind}" has no revert method`);
    }
    this.#reverters.set(subjectKind, reverter);
  }

  find(subjectKind: string): SystemChangeReverter | null {
    return this.#reverters.get(subjectKind) ?? null;
  }

  seal(): void {
    this.#sealed = true;
  }

  kinds(): readonly string[] {
    return [...this.#reverters.keys()].sort();
  }
}
