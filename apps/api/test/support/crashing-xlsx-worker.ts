import { workerData } from 'node:worker_threads';

// A stand-in for the XLSX worker that ends without an answer (a crash): the parent must refuse the
// file as unreadable. Used only by isolated-xlsx-parser.spec.ts through the `entry` option.
void workerData;
process.exit(3);
