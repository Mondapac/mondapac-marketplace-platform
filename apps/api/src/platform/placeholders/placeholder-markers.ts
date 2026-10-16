/**
 * ADR-0031 decision 4 and 4a: the two markers that make a binding count against a production
 * start. A class carrying either one is a binding that must be replaced before the first sale:
 *
 * - `@FailClosedPlaceholder('<port>')`: a constant refusal standing in for another module's
 *   unmerged facade method (decision 1). Every class under `infrastructure/placeholders/` carries
 *   it (the unit rule in `placeholder-files.spec.ts`).
 * - `@PermissiveInterim('<port>')`: a real binding whose interim answer is more permissive than
 *   the final rule (decision 4a).
 *
 * The mark is kept in a module-private `WeakMap`, not in reflection metadata, so nothing outside
 * this file can add, change or remove it; {@link placeholderMarkOf} is the only read.
 */
export type PlaceholderKind = 'fail-closed-placeholder' | 'permissive-interim';

export interface PlaceholderMark {
  readonly kind: PlaceholderKind;
  /** The consumer's port the class is bound to, for example `sellers.allowedProductTypesOf`. */
  readonly port: string;
}

/** Any class, abstract or not. */
export type AnyClass = abstract new (...args: never[]) => unknown;

/** A class decorator that leaves the class as it is. */
export type PlaceholderDecorator = (target: AnyClass) => void;

const marks = new WeakMap<AnyClass, PlaceholderMark>();
/** Every marked class this process has loaded, in load order (see {@link loadedPlaceholders}). */
const loaded: { readonly target: AnyClass; readonly mark: PlaceholderMark }[] = [];

const PORT_NAME = /^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9-]*$/;

function marker(kind: PlaceholderKind, port: string): PlaceholderDecorator {
  if (!PORT_NAME.test(port)) {
    throw new Error(`A placeholder port is named "<module>.<method>"; got "${port}"`);
  }
  return (target) => {
    if (marks.has(target)) throw new Error(`${target.name} carries two placeholder marks`);
    const mark = { kind, port };
    marks.set(target, mark);
    loaded.push({ target, mark });
  };
}

/** ADR-0031 decision 4: a fail-closed placeholder for `port`. */
export function FailClosedPlaceholder(port: string): PlaceholderDecorator {
  return marker('fail-closed-placeholder', port);
}

/** ADR-0031 decision 4a: an interim real binding more permissive than the final rule. */
export function PermissiveInterim(port: string): PlaceholderDecorator {
  return marker('permissive-interim', port);
}

/**
 * The mark of a class or of any class it extends, or `undefined` for an ordinary binding: a
 * subclass of a placeholder is a placeholder (Hassan S2).
 */
export function placeholderMarkOf(target: unknown): PlaceholderMark | undefined {
  let current: unknown = target;
  while (typeof current === 'function') {
    const mark = marks.get(current as AnyClass);
    if (mark !== undefined) return mark;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/**
 * Every marked class loaded into this process, whether or not the container shows it bound: a
 * class built inside a factory, or a request- or transient-scoped provider, has no instance the
 * container can show at start-up (Hassan S1). A placeholder's binding PR deletes the class
 * (decision 3), so a loaded marked class is treated as bound.
 */
export function loadedPlaceholders(): readonly {
  readonly className: string;
  readonly mark: PlaceholderMark;
}[] {
  return loaded.map(({ target, mark }) => ({ className: target.name, mark }));
}
