import { workerData } from 'node:worker_threads';

// A stand-in for the XLSX worker that throws only after the parent's time limit has passed: the
// parent has settled by then and must not let the late error crash the process (Hassan L-586-9).
// Used only by isolated-xlsx-parser.spec.ts through the `entry` option.
void workerData;
const until = Date.now() + 150;
while (Date.now() < until) {
  // Busy, so the throw lands after the parent's timeout and before terminate() takes hold.
}
throw new Error('late failure');
