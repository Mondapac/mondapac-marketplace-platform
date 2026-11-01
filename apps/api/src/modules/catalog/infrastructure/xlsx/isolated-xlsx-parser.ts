import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import {
  isZipContainer,
  type FileRefusal,
  type ImportFileParser,
  type ParsedTable,
} from '../../domain/platform-import/import-file';
import type { ImportLimits } from '../../domain/platform-import/limits';
import type { XlsxWorkerInput, XlsxWorkerOutput } from './xlsx-parse-worker';

// Hassan M-586-8 (round 4): the XLSX parse cannot be made safe one amplification at a time, so the
// whole parse (container checks, prescan, exceljs, canonical CSV) runs in a worker thread:
//  - a heap cap (`resourceLimits`): a file that needs more ends the thread, not the API process;
//  - a wall-clock timeout: a file that takes longer ends the thread (`terminate()`), and the API's
//    event loop never runs any of the parse;
//  - one parse at a time per process: a second upload meanwhile is told to try again shortly.
// Every way the thread can end is a refusal, never an exception.

/** What one parse may use. Real files (5,000 rows of 64 columns) need a little over half of it. */
export const XLSX_WORKER_LIMITS: ResourceLimits = Object.freeze({
  maxOldGenerationSizeMb: 192,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
});

/** The ceiling of one parse. A file at every limit takes about three seconds on a slow machine. */
export const XLSX_PARSE_TIMEOUT_MS = 20_000;

/** How often the parent looks at the thread's heap. */
const HEAP_WATCH_INTERVAL_MS = 100;

/** The `Retry-After` of `file.busy`: about one parse. */
export const XLSX_BUSY_RETRY_SECONDS = 5;

export interface IsolatedXlsxParserOptions {
  readonly timeoutMs?: number;
  readonly resourceLimits?: ResourceLimits;
  /**
   * The most heap, in MiB, the thread may hold before the parent ends it. Default: twice the old
   * generation limit (the watch counts every space, the limit only the old one). See {@link parseInWorker}.
   */
  readonly heapWatchMb?: number;
  /** The worker's entry file (a seam for tests: a thread that crashes). Default: the XLSX worker. */
  readonly entry?: string;
}

const IN_TYPESCRIPT = __filename.endsWith('.ts');
const WORKER_ENTRY = path.join(__dirname, 'xlsx-parse-worker' + (IN_TYPESCRIPT ? '.ts' : '.js'));

// In the build the worker loads the compiled entry (`dist/.../xlsx-parse-worker.js`, emitted by
// `nest build` next to this file). In tests and from source the entry is TypeScript: the worker is
// then started through this bootstrap, which compiles each `.ts` file it requires with the
// TypeScript compiler (a file at a time, no type check) and maps the kernel package to its sources,
// as the Jest and tsc path mappings do.
//
// Every test parse starts a fresh thread, and loading the compiler plus compiling the ~23 files the
// worker needs took about 0.9 s of a 1 s start (more than the parse of a small file). Under a full
// `pnpm test` run, with every core busy, that start alone passed Jest's 5 s default now and then, and
// the next spec of the file then met the still-running parse as `file.busy`. So the compiled output
// is kept on disk, keyed by a hash of the source, the compiler version and these options; a thread
// that finds every file there never loads the compiler. A write goes to a temporary name and is
// renamed into place, so concurrent Jest workers never read half a file.
const TS_BOOTSTRAP = String.raw`
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const aliases = workerData.aliases;
const cacheDir = workerData.cacheDir;
const typescriptVersion = require(workerData.typescript + '/package.json').version;
let ts;
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, Object.prototype.hasOwnProperty.call(aliases, request) ? aliases[request] : request, ...rest);
};
function compile(source, filename) {
  ts ??= require(workerData.typescript);
  return ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
}
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const key = crypto
    .createHash('sha256')
    .update(typescriptVersion + '\0commonjs-es2022-esModuleInterop\0' + filename + '\0' + source)
    .digest('hex');
  const cached = path.join(cacheDir, key + '.js');
  let out;
  try {
    out = fs.readFileSync(cached, 'utf8');
  } catch {
    out = compile(source, filename);
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const temporary = cached + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
      fs.writeFileSync(temporary, out);
      fs.renameSync(temporary, cached);
    } catch {
      // No cache this time: the compiled text above is used as is.
    }
  }
  module._compile(out, filename);
};
require(workerData.entry);
`;

function repositoryRoot(): string {
  let at = __dirname;
  while (!fs.existsSync(path.join(at, 'pnpm-workspace.yaml'))) {
    const up = path.dirname(at);
    if (up === at) throw new Error('repository root not found');
    at = up;
  }
  return at;
}

function typescriptWorker(
  input: XlsxWorkerInput,
  entry: string,
  resourceLimits: ResourceLimits,
): Worker {
  const kernel = path.join(repositoryRoot(), 'packages/shared-kernel/src');
  return new Worker(TS_BOOTSTRAP, {
    eval: true,
    workerData: {
      ...input,
      entry,
      typescript: 'typescript', // resolved from the working directory (tests only)
      cacheDir: path.join(os.tmpdir(), 'mondapac-xlsx-worker-ts'),
      aliases: {
        '@mondapac/shared-kernel': path.join(kernel, 'index.ts'),
        '@mondapac/shared-kernel/testing': path.join(kernel, 'testing.ts'),
        '@mondapac/shared-kernel/contexts': path.join(kernel, 'contexts.ts'),
        '@mondapac/shared-kernel/authenticated-actor': path.join(kernel, 'authenticated-actor.ts'),
      },
    },
    resourceLimits,
  });
}

/** Only one parse at a time per process. */
let running = false;

/** True while a parse is running in this process (for tests and diagnostics). */
export const xlsxParseRunning = (): boolean => running;

const resourceLimitsOf = (options: IsolatedXlsxParserOptions): ResourceLimits =>
  options.resourceLimits ?? XLSX_WORKER_LIMITS;

function parseInWorker(
  bytes: Uint8Array,
  limits: ImportLimits,
  options: IsolatedXlsxParserOptions,
): Promise<Result<ParsedTable, FileRefusal>> {
  return new Promise((resolve) => {
    // The thread gets its own copy of the bytes (structured clone; a transfer is not possible from
    // every realm, Jest's among them).
    const input: XlsxWorkerInput = { bytes, limits };
    let worker: Worker;
    try {
      const resourceLimits = resourceLimitsOf(options);
      const entry = options.entry ?? WORKER_ENTRY;
      worker = IN_TYPESCRIPT
        ? typescriptWorker(input, entry, resourceLimits)
        : new Worker(entry, { workerData: input, resourceLimits });
    } catch {
      resolve(err({ code: 'file.unreadable' }));
      return;
    }
    let settled = false;
    const finish = (result: Result<ParsedTable, FileRefusal>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watcher);
      worker.removeAllListeners();
      // An error the thread raises before terminate() takes hold would otherwise be an 'error'
      // event with no listener, which crashes the process (L-586-9). The answer is settled already.
      worker.on('error', () => undefined);
      // A message may already be posted; the thread has nothing more to do either way.
      void worker.terminate();
      resolve(result);
    };
    // Defence in depth for the heap cap. A process started with `--max-old-space-size` (also
    // through NODE_OPTIONS, common in containers) makes V8 ignore `resourceLimits` for the thread,
    // so the cap above would be void. The parent therefore also looks at the thread's heap, from
    // this thread, which is free while the worker works, and ends a thread that holds too much.
    const watchBytes =
      (options.heapWatchMb ?? 2 * (resourceLimitsOf(options).maxOldGenerationSizeMb ?? 0)) *
      1024 *
      1024;
    let looking = false;
    const watcher = setInterval(() => {
      if (looking || settled) return;
      looking = true;
      worker
        .getHeapStatistics()
        .then((heap) => {
          if (heap.used_heap_size > watchBytes) {
            finish(err({ code: 'file.too-large', maxBytes: limits.fileBytes }));
          }
        })
        .catch(() => undefined)
        .finally(() => {
          looking = false;
        });
    }, HEAP_WATCH_INTERVAL_MS);
    watcher.unref();
    const timer = setTimeout(
      () => finish(err({ code: 'file.too-complex' })),
      options.timeoutMs ?? XLSX_PARSE_TIMEOUT_MS,
    );
    worker.once('message', (output: XlsxWorkerOutput) =>
      finish(output.ok ? ok(output.value) : err(output.error)),
    );
    worker.once('error', (error: NodeJS.ErrnoException) =>
      finish(
        error.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? err({ code: 'file.too-large', maxBytes: limits.fileBytes })
          : err({ code: 'file.unreadable' }),
      ),
    );
    // Ended without an answer (a crash, `process.exit`, a kill): unreadable.
    worker.once('exit', () => finish(err({ code: 'file.unreadable' })));
  });
}

/**
 * The XLSX parser the use cases are given: the same parse as {@link createXlsxParser}, run in a
 * worker thread under a heap cap and a time limit, one at a time per process.
 * - a thread that runs out of memory: `file.too-large`;
 * - a thread that passes the time limit is ended: `file.too-complex`;
 * - a thread that crashes or ends without an answer: `file.unreadable`;
 * - a parse already running in this process: `file.busy` (retryable; answered at once, not queued,
 *   so waiting uploads cannot pile up behind a slow one).
 */
export function createIsolatedXlsxParser(
  options: IsolatedXlsxParserOptions = {},
): ImportFileParser {
  return Object.freeze({
    format: 'xlsx',
    sniff: isZipContainer,
    async parse(
      bytes: Uint8Array,
      limits: ImportLimits,
    ): Promise<Result<ParsedTable, FileRefusal>> {
      if (running) return err({ code: 'file.busy', retryAfterSeconds: XLSX_BUSY_RETRY_SECONDS });
      running = true;
      try {
        return await parseInWorker(bytes, limits, options);
      } finally {
        running = false;
      }
    },
  } satisfies ImportFileParser);
}

/** The parser the use cases are given. */
export const xlsxParser: ImportFileParser = createIsolatedXlsxParser();
