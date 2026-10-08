import { Temporal } from '@mondapac/shared-kernel';

/**
 * The platform constants of the audit chain (docs/design/domain/platform-audit.md 7 and 8;
 * ADR-0032). Platform constants, the same in every Market: none of them is Market
 * configuration.
 */

/**
 * S, the settle window (PA 6.1 option A, 7.2; ADR-0032 decision 3): the sealer seals only rows
 * with `occurred_at <= now - S`. Correct only while no transaction that writes an audit row
 * can live longer than S, so `S >= 4 x (MAX_UNIT_TIMEOUT + STATEMENT_TIMEOUT_CEILING)` is
 * asserted by a unit test that fails the build. Raising a timeout ceiling needs a CTO decision
 * and a change to S in the same change.
 */
export const SETTLE_WINDOW = Temporal.Duration.from({ minutes: 5 });

/** The current chain epoch (PA 6.2, F12): a constant until the epoch table of 9.1 exists. */
export const CURRENT_EPOCH = 1;

/** The epochs the verifier knows: epoch 1, and later the rows of the epoch table (PA 8 (a)). */
export const KNOWN_EPOCHS: readonly number[] = Object.freeze([CURRENT_EPOCH]);

/** Rows sealed per batch, one read-write unit each (PA 7.1 step 3). */
export const SEAL_BATCH_SIZE = 500;

/** How far below the watermark the late-row scan looks (PA 7.1 step 4). */
export const LATE_SCAN_WINDOW = Temporal.Duration.from({ hours: 24 });

/** The late-row scan runs at most this often per Market, and on the first run (F3). */
export const LATE_SCAN_EVERY = Temporal.Duration.from({ minutes: 5 });

/** A checkpoint when the head moved and this long, or {@link CHECKPOINT_ROWS} seals, passed. */
export const CHECKPOINT_EVERY = Temporal.Duration.from({ hours: 1 });
export const CHECKPOINT_ROWS = 10_000n;

/** The heartbeat anchor, once a day per Market (PA 7.1 step 6). */
export const HEARTBEAT_EVERY = Temporal.Duration.from({ hours: 24 });

/** `audit.seal.lagging` when the oldest settled unsealed row is older than this (7.1 step 7). */
export const LAG_ALERT_AFTER = Temporal.Duration.from({ minutes: 15 });

/** `audit.seal.stalled` after this many runs without a moving head while rows wait (step 8). */
export const STALL_RUNS = 3;

/** The sealer job: every 10 s, at most 60 s a run (PA 7.2). */
export const SEAL_JOB_EVERY = Temporal.Duration.from({ seconds: 10 });
export const SEAL_JOB_MAX_RUN_MS = 60_000;

/** The verifier job: every hour, incremental; a full run once a day (PA 8). */
export const VERIFY_JOB_EVERY = Temporal.Duration.from({ hours: 1 });
export const FULL_VERIFY_EVERY = Temporal.Duration.from({ hours: 24 });
export const VERIFY_JOB_MAX_RUN_MS = 600_000;

/** Seals the verifier reads per read-only unit (DP 11.7: 1 000 seals in 2.4 ms). */
export const VERIFY_BATCH_SIZE = 1000;

/** Check (d) runs in time slices of one day, never as one statement (PA 8; DP 11.7). */
export const UNSEALED_SLICE = Temporal.Duration.from({ hours: 24 });

/** The most findings of one kind one verification lists before it stops listing them. */
export const MAX_FINDINGS_PER_CODE = 1000;

/** The settle window in milliseconds. */
export function settleWindowMs(): number {
  return SETTLE_WINDOW.total({ unit: 'milliseconds' });
}

/**
 * ADR-0032 decision 3: S is at least four times the longest a unit that writes an audit row
 * can live (the unit timeout ceiling plus one statement still running when it fires).
 */
export function settleWindowHolds(maxUnitTimeoutMs: number, statementTimeoutCeilingMs: number) {
  return settleWindowMs() >= 4 * (maxUnitTimeoutMs + statementTimeoutCeilingMs);
}
