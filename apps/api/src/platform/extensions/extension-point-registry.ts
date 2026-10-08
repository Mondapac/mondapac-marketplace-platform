import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

/** Registration refused at boot (catalog design 3.1): a programmer or deployment error. */
export class ExtensionRegistryError extends Error {
  override readonly name = 'ExtensionRegistryError';
}

/**
 * Who registers an implementation: the module that owns the point, or a Vertical, whose code
 * lives in a folder `verticals/<vertical>/` (ADR-0001 decisions 1 and 5).
 */
export type Registrant = { readonly module: string } | { readonly vertical: string };

/** Checks that an implementation has the shape of the point's interface. Pure. */
export type ExtensionValidator<T> = (implementation: unknown) => implementation is T;

/** `<owning module>.<point>`, e.g. `catalog.product-type`. */
const POINT_ID = /^([a-z][a-z0-9-]*)\.[a-z][a-z0-9-]*$/;
/** A code that names one implementation of a point. */
export const EXTENSION_CODE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const FOLDER_NAME = /^[a-z][a-z0-9-]*$/;

interface Point {
  readonly owner: string;
  readonly validate: ExtensionValidator<unknown>;
  readonly implementations: Map<string, unknown>;
}

/**
 * The extension-point registry (ADR-0001 decision 1; catalog design 3.1). Generic and
 * module-free: the TypeScript interface of a point is exported from the owning module's
 * `contracts/`, and this class knows only point ids, codes and a validator.
 *
 * Everything is registered at bootstrap. The registry is sealed when the application has
 * bootstrapped (the same in both roles, like the permission and event registries), and
 * implementations are read only after that. Boot fails on a duplicate point or code, a
 * malformed id or code, a registrant that is neither the owning module nor a Vertical folder,
 * or an implementation the validator refuses.
 */
@Injectable()
export class ExtensionPointRegistry implements OnApplicationBootstrap {
  readonly #points = new Map<string, Point>();
  #sealed = false;

  declarePoint<T>(pointId: string, ownerModule: string, validate: ExtensionValidator<T>): void {
    this.#assertOpen();
    const match = POINT_ID.exec(pointId);
    if (match === null || match[1] !== ownerModule) {
      throw new ExtensionRegistryError(
        `Module "${ownerModule}" cannot declare the point "${pointId}": an id starts with its owner`,
      );
    }
    if (this.#points.has(pointId)) {
      throw new ExtensionRegistryError(`The point "${pointId}" is declared twice`);
    }
    if (typeof validate !== 'function') {
      throw new ExtensionRegistryError(`The point "${pointId}" needs a validator`);
    }
    this.#points.set(pointId, { owner: ownerModule, validate, implementations: new Map() });
  }

  register<T>(pointId: string, code: string, implementation: T, registrant: Registrant): void {
    this.#assertOpen();
    const point = this.#points.get(pointId);
    if (point === undefined) {
      throw new ExtensionRegistryError(`The point "${pointId}" is not declared`);
    }
    if (typeof code !== 'string' || !EXTENSION_CODE_PATTERN.test(code)) {
      throw new ExtensionRegistryError(`"${String(code)}" is not a valid code for "${pointId}"`);
    }
    if (!isAllowedRegistrant(registrant, point.owner)) {
      throw new ExtensionRegistryError(
        `The registrant of "${pointId}/${code}" is neither "${point.owner}" nor a Vertical folder`,
      );
    }
    if (point.implementations.has(code)) {
      throw new ExtensionRegistryError(`"${pointId}/${code}" is registered twice`);
    }
    if (!point.validate(implementation)) {
      throw new ExtensionRegistryError(`"${pointId}/${code}" does not fit the point's interface`);
    }
    point.implementations.set(code, implementation);
  }

  seal(): void {
    this.#sealed = true;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  onApplicationBootstrap(): void {
    this.seal();
  }

  /** The implementation registered under `code`, or `undefined`. Only after sealing. */
  get<T>(pointId: string, code: string): T | undefined {
    return this.#pointOf(pointId).implementations.get(code) as T | undefined;
  }

  /** Every code registered for the point, sorted. Only after sealing. */
  codes(pointId: string): string[] {
    return [...this.#pointOf(pointId).implementations.keys()].sort();
  }

  #assertOpen(): void {
    if (this.#sealed) throw new ExtensionRegistryError('The extension-point registry is sealed');
  }

  #pointOf(pointId: string): Point {
    if (!this.#sealed) {
      throw new ExtensionRegistryError('The extension-point registry is read after it is sealed');
    }
    const point = this.#points.get(pointId);
    if (point === undefined) {
      throw new ExtensionRegistryError(`The point "${pointId}" is not declared`);
    }
    return point;
  }
}

function isAllowedRegistrant(registrant: Registrant, owner: string): boolean {
  if (typeof registrant !== 'object' || registrant === null) return false;
  if ('module' in registrant) return registrant.module === owner;
  if ('vertical' in registrant) {
    return typeof registrant.vertical === 'string' && FOLDER_NAME.test(registrant.vertical);
  }
  return false;
}
