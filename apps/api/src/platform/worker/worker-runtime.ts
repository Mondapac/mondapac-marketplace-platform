import { Logger } from '@nestjs/common';
import { RELAY_IDLE_PAUSE_MS, type OutboxRelay, type RelayPass } from '../events/event-bus';
import type { Scheduler } from '../scheduler/scheduler';

/** How long `stop()` waits for the pass and the job runs in flight (P 8). */
export const STOP_GRACE_MS = 10_000;
/** The worker's liveness line in Phase 2 (P 8, PK2). */
export const HEARTBEAT_MS = 60_000;

/**
 * What the `worker` role runs (platform persistence design, "P", 8; ADR-0006 decisions 4
 * and 7): the relay loop and the scheduler; from slice 3 the dispatcher. `main.ts` calls
 * {@link start}; no lifecycle hook starts a loop, so building the graph in a test starts no
 * timer. {@link stop} runs on shutdown: no new pass, up to 10 s for what is in flight. Safety
 * never depends on a clean stop (P 6.2).
 *
 * The relay loop: a pass with a full batch is followed by the next at once; otherwise the
 * loop pauses 500 ms. A failed pass is logged and repeated after the pause.
 */
export class WorkerRuntime {
  private readonly logger = new Logger('WorkerRuntime');
  private running = false;
  private loop: Promise<void> | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly relay: OutboxRelay,
    private readonly scheduler: Scheduler,
    private readonly idlePauseMs: number = RELAY_IDLE_PAUSE_MS,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const unhosted = await this.relay.unhostedMarketsWithRows();
    if (unhosted.length > 0) {
      // P 6.2, "Market": such rows are never claimed here.
      this.logger.error({ msg: 'outbox.unhosted-markets', marketIds: unhosted });
    }
    this.scheduler.start();
    this.loop = this.relayLoop();
    this.heartbeat = setInterval(() => this.logger.log({ msg: 'worker.heartbeat' }), HEARTBEAT_MS);
    this.logger.log({ msg: 'worker.started' });
  }

  async stop(graceMs: number = STOP_GRACE_MS): Promise<void> {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.heartbeat);
    this.wake?.();
    let timeout: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, graceMs);
    });
    await Promise.all([
      Promise.race([this.loop ?? Promise.resolve(), grace]),
      this.scheduler.stop(graceMs),
    ]);
    clearTimeout(timeout);
    this.logger.log({ msg: 'worker.stopped' });
  }

  private async relayLoop(): Promise<void> {
    while (this.running) {
      let pass: RelayPass | undefined;
      try {
        pass = await this.relay.runOnce();
      } catch (error) {
        this.logger.error({ msg: 'outbox.relay-pass-failed', err: error });
      }
      if (this.running && pass?.fullBatch !== true) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, this.idlePauseMs);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
