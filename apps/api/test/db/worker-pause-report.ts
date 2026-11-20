/**
 * Reports a long pause of this Jest worker's event loop while a test (or its hooks) runs.
 *
 * Several database tests race two units: a waiter that has only the role's 3 s lock_timeout
 * waits for a holder that this same worker must commit. On CI such a waiter has ended with
 * 55P03 at exactly 3.0 s while the holder sat idle in an open transaction (sellers files,
 * cart rate counters, lock-stock-items, 17 to 19 Nov 2026). A line from here names the test
 * and tells the two causes apart: high CPU means this process ran synchronous work; low CPU
 * means it was not scheduled (a busy runner) or waited on something outside JavaScript.
 *
 * Quiet unless a pause reaches REPORT_MS; it never fails a test.
 */
const TICK_MS = 100;
const REPORT_MS = 1500;
const ALWAYS_REPORT_MS = 2500;

let last = performance.now();
let lastCpu = process.cpuUsage();

const ticker = setInterval(() => {
  const now = performance.now();
  const cpu = process.cpuUsage();
  const pause = now - last - TICK_MS;
  if (pause >= REPORT_MS) {
    const usedMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    const share = usedMs / (now - last);
    const state = expect.getState();
    // Busy pauses are this process's own synchronous work: loading a spec file between tests,
    // or building an application in a hook when shorter than ALWAYS_REPORT_MS. Not reported.
    const busy = share >= 0.5;
    const inTest = state.currentTestName !== undefined;
    if (!busy || (inTest && pause >= ALWAYS_REPORT_MS)) {
      process.stderr.write(
        `[db-test worker pause] ${(pause / 1000).toFixed(1)} s ending ${new Date().toISOString()}, ` +
          `CPU ${(share * 100).toFixed(0)}% of one core, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB, ` +
          `${state.testPath?.split('/').pop() ?? '?'} › ${state.currentTestName ?? '(between tests)'}\n`,
      );
    }
  }
  last = now;
  lastCpu = cpu;
}, TICK_MS);
ticker.unref();

afterAll(() => clearInterval(ticker));
