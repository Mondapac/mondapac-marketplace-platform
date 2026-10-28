import { parsePlainText } from '@mondapac/shared-kernel';

// The checks shared by every blog input: plain text, ids and closed objects. Content is stored and
// answered as data, never as markup: a text holds no control or format character and no angle
// bracket, and the buyer app renders it as text. Each check pushes `{ path, code }` onto the
// problems of the input instead of throwing. A problem never carries the value.

export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

export type Problems = FieldProblem[];

/** At most this many problems are answered, so a huge body cannot make a huge answer. */
export const MAX_PROBLEMS = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Angle brackets are how markup starts: a text field never holds one. */
const MARKUP = /[<>]/u;
const LINE_BREAK = /[\r\n\t]/u;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function problem(problems: Problems, path: string, code: string): void {
  if (problems.length < MAX_PROBLEMS) problems.push({ path, code });
}

export const at = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`;

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
      problem(problems, at(path, safe), 'unknown-field');
    }
  }
  return true;
}

export interface TextOptions {
  /** The most characters (code points) after trimming. */
  readonly max: number;
  /** The fewest, default 1 (an empty text is `required` unless optional). */
  readonly min?: number;
  /** Absent, null or empty is fine: the result is null. */
  readonly optional?: boolean;
  /** A line break is allowed (a note); default a single line. */
  readonly multiline?: boolean;
}

/**
 * A plain text: NFC, trimmed, of `min` to `max` characters, with no hidden or control character
 * (the kernel's `parsePlainText`, plus every control but the line break of a multiline text) and
 * no angle bracket. Absent and optional: null.
 */
export function plainText(
  problems: Problems,
  path: string,
  value: unknown,
  options: TextOptions,
): string | null {
  const optional = options.optional === true;
  if (value === undefined || value === null) {
    if (!optional) problem(problems, path, 'required');
    return null;
  }
  if (typeof value !== 'string') {
    problem(problems, path, 'type');
    return null;
  }
  const text = value.normalize('NFC').trim();
  if (text.length === 0) {
    if (!optional) problem(problems, path, 'required');
    return null;
  }
  if (MARKUP.test(text)) {
    problem(problems, path, 'markup');
    return null;
  }
  if (options.multiline !== true && LINE_BREAK.test(text)) {
    problem(problems, path, 'format');
    return null;
  }
  const hidden = parsePlainText(text);
  if (!hidden.ok) {
    problem(problems, path, 'invisible-character');
    return null;
  }
  const length = Array.from(text).length;
  if (length > options.max) {
    problem(problems, path, 'length');
    return null;
  }
  if (length < (options.min ?? 1)) {
    problem(problems, path, 'length');
    return null;
  }
  return text;
}

/**
 * A text that may be empty: the empty string is a value (an excerpt not written yet), not
 * `required`. Same rules otherwise.
 */
export function plainTextOrEmpty(
  problems: Problems,
  path: string,
  value: unknown,
  max: number,
): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' && value.trim().length === 0) return '';
  return plainText(problems, path, value, { max }) ?? '';
}

export function uuid(problems: Problems, path: string, value: unknown): string | null {
  if (value === undefined || value === null) {
    problem(problems, path, 'required');
    return null;
  }
  if (typeof value !== 'string' || !UUID.test(value)) {
    problem(problems, path, typeof value === 'string' ? 'format' : 'type');
    return null;
  }
  return value;
}

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
