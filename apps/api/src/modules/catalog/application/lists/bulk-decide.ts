import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

/** The most rows one bulk decision takes (the plan: bulk accept and reject, at most 50). */
export const BULK_DECIDE_MAX = 50;

export interface BulkDecideItem {
  readonly id: string;
  /** The row version the admin saw; a changed row is skipped, never decided blind. */
  readonly version: number;
}

export interface BulkDecideFailure {
  readonly code: 'validation.failed' | 'batch.too-large';
  readonly fields?: readonly { readonly path: string; readonly code: string }[];
  readonly max?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (path: string, code: string): { ok: false; error: BulkDecideFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: BulkDecideFailure;
  };

/** The `items` of a bulk request: 1 to 50 rows, each `{ id, version }`, no id twice. */
export function parseBulkItems(raw: unknown): Result<readonly BulkDecideItem[], BulkDecideFailure> {
  if (!Array.isArray(raw)) return bad('items', 'type');
  if (raw.length === 0) return bad('items', 'required');
  if (raw.length > BULK_DECIDE_MAX) {
    return err({ code: 'batch.too-large', max: BULK_DECIDE_MAX });
  }
  const seen = new Set<string>();
  const items: BulkDecideItem[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return bad(`items.${index}`, 'type');
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'id' && key !== 'version') return bad(`items.${index}.${key}`, 'unknown');
    }
    const { id, version } = record;
    if (typeof id !== 'string' || !UUID.test(id)) return bad(`items.${index}.id`, 'format');
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > 2147483647
    ) {
      return bad(`items.${index}.version`, 'type');
    }
    if (seen.has(id.toLowerCase())) return bad(`items.${index}.id`, 'duplicate');
    seen.add(id.toLowerCase());
    items.push({ id, version });
  }
  return ok(items);
}

export type BulkOutcome = 'done' | 'skipped' | 'failed';

/** What happened to one row: a stable code, never text. */
export interface BulkDecideResult {
  readonly id: string;
  readonly outcome: BulkOutcome;
  readonly reason?: string;
}

export interface BulkDecideCounts {
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
}

/** Refusals of one row that mean "this row is not decidable now": the row is skipped. */
const SKIPPED_CODES = new Set([
  'access.denied',
  'conflict.stale',
  'category-proposal.not-allowed',
  // The review queue: a revision that needs ticked checks is left for a person (never ticked in
  // bulk), a seller who may not sell now or a product that is not published is not decidable now.
  'review.checks-missing',
  'review.not-current-revision',
  'offer.product-not-published',
  'seller.not-eligible',
]);

const isSkipped = (code: string): boolean =>
  SKIPPED_CODES.has(code) ||
  code.endsWith('.not-found') ||
  code.endsWith('.not-open') ||
  code.endsWith('.not-pending') ||
  code.endsWith('.not-pending-review') ||
  code.endsWith('.stale');

/**
 * Runs `decide` for each row, one after the other (each is its own unit and audit row), and tells
 * what happened to every row. A row that cannot be decided now is skipped; an unexpected refusal
 * or a throw is a failure of that row only, so one bad row never blocks the others.
 */
export async function runBulkDecide(
  items: readonly BulkDecideItem[],
  decide: (item: BulkDecideItem) => Promise<Result<unknown, { readonly code: string }>>,
): Promise<{ results: readonly BulkDecideResult[]; counts: BulkDecideCounts }> {
  const results: BulkDecideResult[] = [];
  for (const item of items) {
    try {
      const answer = await decide(item);
      if (answer.ok) results.push({ id: item.id, outcome: 'done' });
      else {
        results.push({
          id: item.id,
          outcome: isSkipped(answer.error.code) ? 'skipped' : 'failed',
          reason: answer.error.code,
        });
      }
    } catch {
      results.push({ id: item.id, outcome: 'failed', reason: 'unexpected' });
    }
  }
  return {
    results,
    counts: {
      done: results.filter((r) => r.outcome === 'done').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
    },
  };
}
