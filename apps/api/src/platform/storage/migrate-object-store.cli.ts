import { loadAppConfig } from '../config/app-config';
import { DiskObjectStore } from './disk-object-store';
import { isComplete, migrateObjects } from './migrate-object-store';
import { S3ObjectStore } from './s3-object-store';

/**
 * `pnpm --filter @mondapac/api storage:migrate`: copies the disk object store to the S3 bucket.
 * Needs the s3 settings and `OBJECT_STORE_DIR` (the source) in the environment. Prints counts
 * and key names only, never object bytes or secrets. Exit 0 only when the target matches.
 */
async function main(): Promise<number> {
  const config = loadAppConfig(process.env);
  const sourceDir = process.env['OBJECT_STORE_DIR'];
  if (config.objectStore?.driver !== 's3' || sourceDir === undefined) {
    process.stderr.write(
      'Set OBJECT_STORE_DRIVER=s3 with its bucket and region, and OBJECT_STORE_DIR as the source.\n',
    );
    return 2;
  }
  const source = new DiskObjectStore(sourceDir);
  const target = new S3ObjectStore(config.objectStore);
  await target.verify();
  const report = await migrateObjects(await source.keys(), source, target);
  const line = (label: string, value: string | number): void => {
    process.stdout.write(`${label}: ${value}\n`);
  };
  line('objects in source', report.total);
  line('copied', report.copied.length);
  line('already identical', report.identical.length);
  line('conflicts (different bytes in target)', report.conflicts.length);
  line('failed', report.failed.length);
  line('source sha256', report.sourceSha256);
  line('target sha256', report.targetSha256);
  for (const key of [...report.conflicts, ...report.failed]) line('needs attention', key);
  const ok = isComplete(report);
  line('result', ok ? 'complete: target matches source' : 'INCOMPLETE');
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'migration failed'}\n`);
    process.exit(1);
  },
);
