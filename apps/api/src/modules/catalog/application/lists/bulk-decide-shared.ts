import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { BulkDecideCounts, BulkDecideFailure, BulkDecideResult } from './bulk-decide';

// The bulk accept and reject of the admin queues (super list: bulk actions, at most 50 rows). Each
// row goes through the queue's own single use case, as the caller, in its own unit and with its
// own audit row and key check: a bulk request grants nothing the single decision does not, and a
// row that cannot be decided now (changed, decided, a key missing) is skipped, never forced.

export interface BulkDecideOutput {
  readonly action: string;
  readonly counts: BulkDecideCounts;
  /** Every row, in the order given. */
  readonly results: readonly BulkDecideResult[];
}

export type BulkDecideRefusal =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | BulkDecideFailure;

export const refuse = (path: string, code: string): { ok: false; error: BulkDecideRefusal } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: BulkDecideRefusal;
  };

export function closed(
  input: unknown,
  keys: readonly string[],
): Result<Readonly<Record<string, unknown>>, BulkDecideRefusal> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return refuse('body', 'type');
  }
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) return refuse(key, 'unknown');
  }
  return ok(input as Readonly<Record<string, unknown>>);
}

export const adminOnly = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';
