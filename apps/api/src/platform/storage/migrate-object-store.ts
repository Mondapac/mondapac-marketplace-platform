import { createHash } from 'node:crypto';
import type { ObjectStore } from './object-store';

export interface MigrationReport {
  readonly total: number;
  /** Written to the target in this run. */
  readonly copied: readonly string[];
  /** Already in the target with the same bytes. */
  readonly identical: readonly string[];
  /** In the target with different bytes: left untouched, a person decides. */
  readonly conflicts: readonly string[];
  /** Read from the source as missing, or failed to read back after the copy. */
  readonly failed: readonly string[];
  readonly sourceSha256: string;
  readonly targetSha256: string;
}

const digest = (hash: ReturnType<typeof createHash>, key: string, bytes: Buffer): void => {
  hash.update(`${key}\n${createHash('sha256').update(bytes).digest('hex')}\n`);
};

/**
 * Copies every key from `source` to `target` under the same key, then reads each object back
 * and compares bytes. It never overwrites a different object and never deletes from the source.
 * It is safe to run again: copied objects count as identical. The two digests (over key and
 * content hash, in key order) match when the target holds exactly what the source held.
 */
export async function migrateObjects(
  keys: readonly string[],
  source: ObjectStore,
  target: ObjectStore,
): Promise<MigrationReport> {
  const copied: string[] = [];
  const identical: string[] = [];
  const conflicts: string[] = [];
  const failed: string[] = [];
  const sourceHash = createHash('sha256');
  const targetHash = createHash('sha256');
  for (const key of [...keys].sort()) {
    const original = await source.get(key);
    if (original === null) {
      failed.push(key);
      continue;
    }
    digest(sourceHash, key, original);
    const existing = await target.get(key);
    if (existing !== null && !existing.equals(original)) {
      conflicts.push(key);
      continue;
    }
    if (existing === null) await target.put(key, original);
    const readBack = await target.get(key);
    if (readBack === null || !readBack.equals(original)) {
      failed.push(key);
      continue;
    }
    digest(targetHash, key, readBack);
    (existing === null ? copied : identical).push(key);
  }
  return {
    total: keys.length,
    copied,
    identical,
    conflicts,
    failed,
    sourceSha256: sourceHash.digest('hex'),
    targetSha256: targetHash.digest('hex'),
  };
}

/** True when every source object is in the target with the same bytes. */
export function isComplete(report: MigrationReport): boolean {
  return (
    report.conflicts.length === 0 &&
    report.failed.length === 0 &&
    report.sourceSha256 === report.targetSha256
  );
}
