import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { PdfVerdict } from '../application/intake/document-inspection';

// Runs the PDF byte scan off the event loop (security review of PR 382, H1/M2): a worker thread
// with a heap limit and a wall-clock timeout. A worker that runs out of time or memory is ended
// and the file is refused (fail closed): `file.inspection-timeout` or `file.too-complex`.

/** The scan of a 10 MiB file takes well under a second; this is the ceiling, not the budget. */
export const PDF_INSPECTION_TIMEOUT_MS = 5_000;
const WORKER_LIMITS = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
} as const;

// The worker loads the inspection module itself: compiled JavaScript in the build, and in tests
// (where the module is TypeScript) a one-file transpile with the TypeScript compiler. The module
// has no import besides node:zlib, so nothing else needs loading.
const BOOTSTRAP = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
let mod;
if (workerData.file.endsWith('.ts')) {
  const fs = require('node:fs');
  const Module = require('node:module');
  const ts = require(workerData.typescript); // resolved from the working directory (tests only)
  const out = ts.transpileModule(fs.readFileSync(workerData.file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const m = new Module(workerData.file);
  m.filename = workerData.file;
  m.paths = Module._nodeModulePaths(require('node:path').dirname(workerData.file));
  m._compile(out, workerData.file);
  mod = m.exports;
} else {
  mod = require(workerData.file);
}
parentPort.on('message', (bytes) => parentPort.postMessage(mod.inspectPdf(bytes)));
`;

const inTypeScript = __filename.endsWith('.ts');
const MODULE_FILE = path.resolve(
  __dirname,
  '../application/intake/document-inspection' + (inTypeScript ? '.ts' : '.js'),
);

/** Idle workers kept for the next file (a start costs more than a scan). Never more than the slots. */
const idle: Worker[] = [];
const MAX_IDLE = 2;

function startWorker(): Worker {
  const worker = new Worker(BOOTSTRAP, {
    eval: true,
    workerData: { file: MODULE_FILE, typescript: 'typescript' },
    resourceLimits: WORKER_LIMITS,
  });
  // A parked worker must not keep the process alive.
  worker.unref();
  return worker;
}

/**
 * Inspects a PDF in a worker thread; never throws, always answers a verdict. A worker that
 * answers is kept for the next file; one that times out, fails or runs out of memory is ended.
 */
export function inspectPdfIsolated(
  bytes: Uint8Array,
  timeoutMs: number = PDF_INSPECTION_TIMEOUT_MS,
): Promise<PdfVerdict> {
  return new Promise<PdfVerdict>((resolve) => {
    let worker: Worker;
    try {
      worker = idle.pop() ?? startWorker();
    } catch {
      resolve({ ok: false, code: 'file.unreadable' });
      return;
    }
    let settled = false;
    const finish = (verdict: PdfVerdict, reuse: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
      if (reuse && idle.length < MAX_IDLE) {
        worker.unref();
        idle.push(worker);
      } else {
        void worker.terminate();
      }
      resolve(verdict);
    };
    const timer = setTimeout(
      () => finish({ ok: false, code: 'file.inspection-timeout' }, false),
      timeoutMs,
    );
    worker.ref();
    worker.once('message', (verdict: PdfVerdict) => finish(verdict, true));
    worker.once('error', (error: NodeJS.ErrnoException) =>
      finish(
        {
          ok: false,
          code: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'file.too-complex' : 'file.unreadable',
        },
        false,
      ),
    );
    worker.once('exit', () => finish({ ok: false, code: 'file.unreadable' }, false));
    worker.postMessage(bytes);
  });
}
