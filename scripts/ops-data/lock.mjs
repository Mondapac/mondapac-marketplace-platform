// The operational test environment's lock (operational test data design, phase 3): a reset, a fast
// restore and a loader run must not overlap. `refresh` and the loader hold a "run" lock for the life
// of their process (pid, so a crashed run does not block for ever). A reset spans several processes
// (wipe, then the API and the loader, then the backup), so it holds a "reset" lock written by
// `wipe` and removed by `backup`, and goes stale after RESET_TTL_MS. The loader the reset itself
// starts passes `withinReset`. `ops.mjs unlock` clears a lock by hand.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const RESET_TTL_MS = 90 * 60 * 1000;

const lockFile = (dir) => resolve(dir, 'lock.json');

export function readLock(dir) {
  const file = lockFile(dir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** True when a process with this pid is alive (EPERM means it is, owned by someone else). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The lock that currently blocks, or null: a live run, or a reset younger than the TTL. */
export function activeLock(dir, now = Date.now()) {
  const lock = readLock(dir);
  if (!lock) return null;
  if (lock.kind === 'run') return pidAlive(lock.pid) && lock.pid !== process.pid ? lock : null;
  if (lock.kind === 'reset') return now - Date.parse(lock.at) < RESET_TTL_MS ? lock : null;
  return null;
}

function write(dir, lock) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockFile(dir), `${JSON.stringify(lock)}\n`);
}

const describe = (lock) =>
  lock.kind === 'run'
    ? `${lock.command} is running (process ${lock.pid})`
    : `a reset started at ${lock.at} has not finished`;

/** Takes the reset lock (`wipe`, `restore`); throws when another run or reset holds one. */
export function beginReset(dir, command, now = Date.now()) {
  const held = activeLock(dir, now);
  if (held)
    throw new Error(`${describe(held)}. Wait for it, or run: node scripts/ops-data/ops.mjs unlock`);
  write(dir, { kind: 'reset', command, at: new Date(now).toISOString() });
}

export function endReset(dir) {
  if (readLock(dir)?.kind === 'reset') rmSync(lockFile(dir), { force: true });
}

/**
 * Takes the run lock for this process and returns the function that gives it back. During a reset
 * it throws, unless `withinReset` (the loader the reset itself started): that run takes no lock.
 */
export function acquireRun(dir, command, { withinReset = false, now = Date.now() } = {}) {
  const held = activeLock(dir, now);
  if (held?.kind === 'reset' && withinReset) return () => {};
  if (held)
    throw new Error(`${describe(held)}. Wait for it, or run: node scripts/ops-data/ops.mjs unlock`);
  write(dir, { kind: 'run', command, pid: process.pid, at: new Date(now).toISOString() });
  const release = () => {
    if (readLock(dir)?.pid === process.pid) rmSync(lockFile(dir), { force: true });
  };
  process.once('exit', release);
  return release;
}

export function unlock(dir) {
  rmSync(lockFile(dir), { force: true });
}
