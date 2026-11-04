import { parentPort, workerData } from 'node:worker_threads';
import type { FileRefusal, ParsedTable } from '../../domain/platform-import/import-file';
import type { ImportLimits } from '../../domain/platform-import/limits';
import { createXlsxParser } from './xlsx-import-parser';

/**
 * The entry of the XLSX worker thread (Hassan M-586-8, round 4): it reads the bytes and the limits
 * it was started with, runs the whole parse ({@link createXlsxParser}: container checks, prescan,
 * exceljs, canonical CSV) and posts the answer once. Nothing else runs here. The thread's heap is
 * capped by its starter (`resourceLimits`) and its time by a wall-clock `terminate()`, so a file
 * that asks for too much ends this thread and never the API process.
 *
 * Only {@link isolated-xlsx-parser} starts it. A plain `import` of this file in the main thread
 * does nothing.
 */
export interface XlsxWorkerInput {
  readonly bytes: Uint8Array;
  readonly limits: ImportLimits;
}

/** What the thread posts back: the parse's own answer, as plain data. */
export type XlsxWorkerOutput =
  | { readonly ok: true; readonly value: ParsedTable }
  | { readonly ok: false; readonly error: FileRefusal };

if (parentPort !== null && workerData !== null && typeof workerData === 'object') {
  const port = parentPort;
  const input = workerData as XlsxWorkerInput;
  Promise.resolve(createXlsxParser().parse(input.bytes, input.limits))
    .then((result) => {
      const output: XlsxWorkerOutput = result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: result.error };
      port.postMessage(output);
    })
    .catch(() => {
      const output: XlsxWorkerOutput = { ok: false, error: { code: 'file.unreadable' } };
      port.postMessage(output);
    });
}
