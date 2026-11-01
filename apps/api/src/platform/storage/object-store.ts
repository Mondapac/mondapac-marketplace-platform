import type { Temporal } from '@mondapac/shared-kernel';

/** The port to private object storage (ADR-0029 decision 2, simplified for the first release). */
export const OBJECT_STORE = Symbol('OBJECT_STORE');

/** No object store is configured, or it failed: the caller answers "unavailable". */
export class ObjectStoreUnavailableError extends Error {
  override readonly name = 'ObjectStoreUnavailableError';
  constructor(message = 'object storage is not available') {
    super(message);
  }
}

/** The key already holds an object: a write never replaces one (file storage pilot F2b). */
export class ObjectAlreadyExistsError extends Error {
  override readonly name = 'ObjectAlreadyExistsError';
  constructor(message = 'an object already exists under this key') {
    super(message);
  }
}

/**
 * A key is built by code, never taken from a request: `/`-separated segments of letters,
 * digits, `_` and `-`. No dot, no empty segment, so a key can never climb out of its root.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SEGMENTS = 6;

export function isValidObjectKey(key: string): boolean {
  const segments = key.split('/');
  return segments.length <= MAX_SEGMENTS && segments.every((segment) => SEGMENT.test(segment));
}

export function assertObjectKey(key: string): void {
  if (!isValidObjectKey(key)) throw new Error('invalid object key');
}

/** One stored object as a listing shows it. */
export interface ListedObject {
  readonly key: string;
  /** When the object was written (the grace period of a sweep counts from here). */
  readonly lastModified: Temporal.Instant;
}

export interface ObjectListPage {
  readonly objects: readonly ListedObject[];
  /** Pass as `after` for the next page; null on the last page. */
  readonly next: string | null;
}

export const MAX_LIST_LIMIT = 1000;

export interface ObjectStore {
  /**
   * Writes the bytes under the key. Never replaces: a key that holds an object rejects with
   * `ObjectAlreadyExistsError`, and the old object is untouched. Callers build a fresh key per write.
   */
  put(key: string, bytes: Buffer): Promise<void>;
  /** The bytes, or null when the key holds nothing. */
  get(key: string): Promise<Buffer | null>;
  /**
   * Objects whose key lies under the prefix (a path of whole segments such as `a/b`, or `''` for
   * every object), in key order, after the key `after`. A page holds at most `limit` (1 to
   * {@link MAX_LIST_LIMIT}) objects. Keys that are not valid object keys (stray or temporary
   * files) are left out. Costs one request per page: use it for sweeps, never on a request path.
   */
  list(
    prefix: string,
    options: { readonly after: string | null; readonly limit: number },
  ): Promise<ObjectListPage>;
  /** Removes the object; a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** A prefix is `''` or whole valid segments; checked by every adapter. */
export function assertListPrefix(prefix: string): void {
  if (prefix !== '' && !isValidObjectKey(prefix)) throw new Error('invalid object key prefix');
}

/** True when the key lies under the prefix (a whole-segment match, so `a/b` is not under `a/bc`). */
export function isUnderPrefix(key: string, prefix: string): boolean {
  return prefix === '' || key.startsWith(`${prefix}/`);
}

export function assertListLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error('invalid list limit');
  }
}
