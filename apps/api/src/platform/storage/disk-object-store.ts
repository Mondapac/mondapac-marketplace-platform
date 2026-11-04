import { randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Temporal } from '@mondapac/shared-kernel';
import {
  assertListLimit,
  assertListPrefix,
  assertObjectKey,
  isUnderPrefix,
  isValidObjectKey,
  type ObjectListPage,
  ObjectAlreadyExistsError,
  ObjectStoreUnavailableError,
  type ObjectStore,
} from './object-store';

/**
 * The local object store: one file per key under a root directory. It is the stand-in for the
 * demo and for tests; the S3 adapter replaces it behind the same port. A write goes
 * to a temporary name and is hard-linked into place, never over an existing object, so a reader never sees half an object.
 */
export class DiskObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  #pathOf(key: string): string {
    assertObjectKey(key);
    return path.join(this.root, ...key.split('/'));
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const target = this.#pathOf(key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let exists = false;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temporary, bytes, { flag: 'wx' });
      // A hard link fails when the target exists, atomically: no check-then-write race, and a
      // reader never sees half an object.
      await link(temporary, target);
    } catch (error) {
      exists = (error as NodeJS.ErrnoException).code === 'EEXIST';
      if (!exists) throw new ObjectStoreUnavailableError();
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    if (exists) throw new ObjectAlreadyExistsError();
  }

  async get(key: string): Promise<Buffer | null> {
    const target = this.#pathOf(key);
    try {
      return await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ObjectStoreUnavailableError();
    }
  }

  async list(
    prefix: string,
    options: { readonly after: string | null; readonly limit: number },
  ): Promise<ObjectListPage> {
    assertListPrefix(prefix);
    assertListLimit(options.limit);
    const all = (await this.keys()).filter(
      (key) => isUnderPrefix(key, prefix) && (options.after === null || key > options.after),
    );
    const page = all.slice(0, options.limit);
    try {
      const objects = await Promise.all(
        page.map(async (key) => ({
          key,
          lastModified: Temporal.Instant.fromEpochMilliseconds(
            Math.trunc((await stat(this.#pathOf(key))).mtimeMs),
          ),
        })),
      );
      return { objects, next: all.length > page.length ? (page[page.length - 1] ?? null) : null };
    } catch {
      throw new ObjectStoreUnavailableError();
    }
  }

  /** Every stored key, for the disk-to-S3 migration. Skips temporary files and stray names. */
  async keys(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (relative: string[]): Promise<void> => {
      let entries;
      try {
        entries = await readdir(path.join(this.root, ...relative), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new ObjectStoreUnavailableError();
      }
      for (const entry of entries) {
        const next = [...relative, entry.name];
        if (entry.isDirectory()) await walk(next);
        else if (entry.isFile() && isValidObjectKey(next.join('/'))) found.push(next.join('/'));
      }
    };
    await walk([]);
    return found.sort();
  }

  async delete(key: string): Promise<void> {
    const target = this.#pathOf(key);
    try {
      await rm(target, { force: true });
    } catch {
      throw new ObjectStoreUnavailableError();
    }
  }
}

/** Used when `OBJECT_STORE_DIR` is not set: every call says storage is unavailable. */
export class UnconfiguredObjectStore implements ObjectStore {
  put(): Promise<void> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
  get(): Promise<Buffer | null> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
  list(): Promise<ObjectListPage> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
  delete(): Promise<void> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
}

/** Test double: objects kept in memory. A bad key rejects the promise, as the other adapters do. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  /** Write times for `list`; a test sets one to age an object. */
  readonly modified = new Map<string, Temporal.Instant>();
  now: () => Temporal.Instant = () => Temporal.Instant.fromEpochMilliseconds(1_000);
  put(key: string, bytes: Buffer): Promise<void> {
    if (!isValidObjectKey(key)) return Promise.reject(new Error('invalid object key'));
    if (this.objects.has(key)) return Promise.reject(new ObjectAlreadyExistsError());
    this.objects.set(key, Buffer.from(bytes));
    this.modified.set(key, this.now());
    return Promise.resolve();
  }
  get(key: string): Promise<Buffer | null> {
    if (!isValidObjectKey(key)) return Promise.reject(new Error('invalid object key'));
    return Promise.resolve(this.objects.get(key) ?? null);
  }
  list(
    prefix: string,
    options: { readonly after: string | null; readonly limit: number },
  ): Promise<ObjectListPage> {
    try {
      assertListPrefix(prefix);
      assertListLimit(options.limit);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('invalid list'));
    }
    const all = [...this.objects.keys()]
      .filter(
        (key) => isUnderPrefix(key, prefix) && (options.after === null || key > options.after),
      )
      .sort();
    const page = all.slice(0, options.limit);
    return Promise.resolve({
      objects: page.map((key) => ({ key, lastModified: this.modified.get(key) ?? this.now() })),
      next: all.length > page.length ? (page[page.length - 1] ?? null) : null,
    });
  }
  delete(key: string): Promise<void> {
    if (!isValidObjectKey(key)) return Promise.reject(new Error('invalid object key'));
    this.objects.delete(key);
    this.modified.delete(key);
    return Promise.resolve();
  }
}
