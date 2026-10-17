// The checks shared by every storefront input: plain text, site paths and links, ready-made image
// references and ids. Content is stored and answered as data, never as markup: a text holds no
// control or format character and the buyer app renders it as text. Each check pushes
// `{ path, code }` onto the problems of the input instead of throwing.

export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

export type Problems = FieldProblem[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** A site path: starts with one slash, no scheme, no `//`, no `..` segment, plain URL characters. */
const SITE_PATH = /^\/(?!\/)[A-Za-z0-9/_.~%?=&+-]*$/u;
const IMAGE_REF = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CODE = /^[a-z][a-z0-9-]{0,31}$/u;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
/** At most this many problems are answered, so a huge body cannot make a huge answer. */
export const MAX_PROBLEMS = 20;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function problem(problems: Problems, path: string, code: string): void {
  if (problems.length < MAX_PROBLEMS) problems.push({ path, code });
}

/** Refuses any key of `value` outside `allowed`. False when `value` is not an object. */
export function closedObject(
  problems: Problems,
  path: string,
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    problem(problems, path, 'type');
    return false;
  }
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) {
      const safe = Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�');
      problem(problems, path === '' ? safe : `${path}.${safe}`, 'unknown-field');
    }
  }
  return true;
}

const join = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`;

export const at = join;

/** A plain one-line text, trimmed, of 1..max characters. Absent and `optional`: null. */
export function text(
  problems: Problems,
  path: string,
  value: unknown,
  max: number,
  optional = false,
): string | null {
  if (value === undefined || value === null) {
    if (!optional) problem(problems, path, 'required');
    return null;
  }
  if (typeof value !== 'string') {
    problem(problems, path, 'type');
    return null;
  }
  const trimmed = value.normalize('NFC').trim();
  if (trimmed.length === 0) {
    if (!optional) problem(problems, path, 'required');
    return null;
  }
  if (HIDDEN.test(trimmed)) {
    problem(problems, path, 'format');
    return null;
  }
  if (Array.from(trimmed).length > max) {
    problem(problems, path, 'length');
    return null;
  }
  return trimmed;
}

/** A link target: a site path, or an absolute `https:` URL with a host. */
export function href(
  problems: Problems,
  path: string,
  value: unknown,
  optional = false,
): string | null {
  if (value === undefined || value === null) {
    if (!optional) problem(problems, path, 'required');
    return null;
  }
  if (typeof value !== 'string' || value.length > 500) {
    problem(problems, path, typeof value === 'string' ? 'length' : 'type');
    return null;
  }
  if (sitePath(value)) return value;
  if (value.startsWith('https://')) {
    try {
      const url = new URL(value);
      if (
        url.protocol === 'https:' &&
        url.hostname !== '' &&
        url.username === '' &&
        url.password === ''
      ) {
        return url.toString();
      }
    } catch {
      // Not a URL: falls through to `format`.
    }
  }
  problem(problems, path, 'format');
  return null;
}

export const sitePath = (value: string): boolean =>
  value.length <= 200 && SITE_PATH.test(value) && !value.split(/[/?]/u).includes('..');

/** A ready-made image (a key of the buyer app's image set, until catalog media exists) and its alt text. */
export function image(
  problems: Problems,
  path: string,
  value: unknown,
  optional = false,
): { readonly ref: string; readonly alt: string } | null {
  if (value === undefined || value === null) {
    if (!optional) problem(problems, path, 'required');
    return null;
  }
  if (!closedObject(problems, path, value, ['ref', 'alt'])) return null;
  const ref = value.ref;
  if (typeof ref !== 'string' || !IMAGE_REF.test(ref)) {
    problem(problems, join(path, 'ref'), ref === undefined ? 'required' : 'format');
  }
  // Alt text is required on every image (analysis 4).
  const alt = text(problems, join(path, 'alt'), value.alt, 160);
  return typeof ref === 'string' && IMAGE_REF.test(ref) && alt !== null ? { ref, alt } : null;
}

export function uuid(problems: Problems, path: string, value: unknown): string | null {
  if (typeof value === 'string' && UUID.test(value)) return value;
  problem(problems, path, value === undefined ? 'required' : 'format');
  return null;
}

export function code(problems: Problems, path: string, value: unknown): string | null {
  if (typeof value === 'string' && CODE.test(value)) return value;
  problem(problems, path, value === undefined ? 'required' : 'format');
  return null;
}

export function wholeNumber(
  problems: Problems,
  path: string,
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  problem(problems, path, value === undefined ? 'required' : 'range');
  return null;
}

export function oneOf<T extends string>(
  problems: Problems,
  path: string,
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  problem(problems, path, value === undefined ? 'required' : 'enum');
  return null;
}

/** An array of `min..max` items, each checked by `item`; null when it is not one. */
export function list<T>(
  problems: Problems,
  path: string,
  value: unknown,
  min: number,
  max: number,
  item: (itemPath: string, entry: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) {
    problem(problems, path, value === undefined ? 'required' : 'type');
    return null;
  }
  if (value.length < min || value.length > max) {
    problem(problems, path, 'count');
    return null;
  }
  const out: T[] = [];
  value.forEach((entry, index) => {
    const checked = item(join(path, index), entry);
    if (checked !== null) out.push(checked);
  });
  return out.length === value.length ? out : null;
}
