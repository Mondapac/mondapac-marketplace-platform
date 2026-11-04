import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertObjectKey,
  isValidObjectKey,
  ObjectStoreUnavailableError,
  type ObjectStore,
} from './object-store';

/**
 * The local object store: one file per key under a root directory. It is the stand-in for the
 * demo and for tests; an S3-compatible adapter replaces it behind the same port. A write goes
 * to a temporary name and is renamed, so a reader never sees half an object.
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
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, target);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new ObjectStoreUnavailableError();
    }
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
  delete(): Promise<void> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
}

/** Test double: objects kept in memory. A bad key rejects the promise, as the other adapters do. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  put(key: string, bytes: Buffer): Promise<void> {
    if (!isValidObjectKey(key)) return Promise.reject(new Error('invalid object key'));
    this.objects.set(key, Buffer.from(bytes));
    return Promise.resolve();
  }
  get(key: string): Promise<Buffer | null> {
    if (!isValidObjectKey(key)) return Promise.reject(new Error('invalid object key'));
    return Promise.resolve(this.objects.get(key) ?? null);
  }
  delete(key: string): Promise<void> {
    if (!isValidObjectKey(key)) return Promise.reject(new Error('invalid object key'));
    this.objects.delete(key);
    return Promise.resolve();
  }
}
