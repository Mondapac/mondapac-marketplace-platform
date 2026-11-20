import { Temporal } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { FieldError } from './conversation';

/** The longest range one insights read covers, in days. */
export const MAX_INSIGHTS_DAYS = 92;
/** The default range, ending today, in days. */
export const DEFAULT_INSIGHTS_DAYS = 30;
/** Unanswered rows kept after grouping (plan: top 200). */
export const MAX_UNANSWERED_ROWS = 200;
/** Flagged turns read to build them, newest first; more is reported as `truncated`. */
export const MAX_UNANSWERED_CANDIDATES = 1000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
/** The longest query shown, in characters. */
export const MAX_QUERY_CHARACTERS = 200;

/** Why a turn counts as unanswered. */
export const UNANSWERED_REASONS = [
  'unavailable',
  'tool-failed',
  'no-results',
  'thumbs-down',
] as const;
export type UnansweredReason = (typeof UNANSWERED_REASONS)[number];

/** One flagged turn: the buyer's (already masked) line, when, and why. */
export interface UnansweredCandidate {
  readonly text: string;
  readonly at: Temporal.Instant;
  readonly reasons: readonly UnansweredReason[];
}

export interface UnansweredRow {
  /** The most recent wording of the group, masked, at most 200 characters. */
  readonly query: string;
  readonly count: number;
  readonly lastAt: Temporal.Instant;
  readonly reasons: Readonly<Record<UnansweredReason, number>>;
}

/**
 * The key two wordings of one question share: Unicode-folded, lower case, punctuation and
 * symbols removed, spaces collapsed. Empty when nothing is left.
 */
export function normalizeQuery(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{C}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const shown = (text: string): string => {
  const letters = [...text.replace(/\s+/gu, ' ').trim()];
  return letters.length <= MAX_QUERY_CHARACTERS
    ? letters.join('')
    : `${letters.slice(0, MAX_QUERY_CHARACTERS - 1).join('')}…`;
};

/**
 * Groups flagged turns by normalized query: most asked first, then most recent, at most 200
 * rows. A turn with several reasons counts once for the group and once for each reason.
 */
export function groupUnanswered(candidates: readonly UnansweredCandidate[]): UnansweredRow[] {
  const groups = new Map<
    string,
    { latest: UnansweredCandidate; count: number; reasons: Record<UnansweredReason, number> }
  >();
  for (const candidate of candidates) {
    const key = normalizeQuery(candidate.text);
    if (key === '') continue;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        latest: candidate,
        count: 0,
        reasons: { unavailable: 0, 'tool-failed': 0, 'no-results': 0, 'thumbs-down': 0 },
      };
      groups.set(key, group);
    }
    group.count += 1;
    for (const reason of new Set(candidate.reasons)) group.reasons[reason] += 1;
    if (candidate.at.epochMilliseconds > group.latest.at.epochMilliseconds)
      group.latest = candidate;
  }
  return [...groups.values()]
    .sort(
      (a, b) => b.count - a.count || b.latest.at.epochMilliseconds - a.latest.at.epochMilliseconds,
    )
    .slice(0, MAX_UNANSWERED_ROWS)
    .map((group) => ({
      query: shown(group.latest.text),
      count: group.count,
      lastAt: group.latest.at,
      reasons: group.reasons,
    }));
}

export interface InsightsQuery {
  readonly from: Temporal.PlainDate;
  readonly to: Temporal.PlainDate;
  readonly page: number;
  readonly pageSize: number;
}

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const QUERY_KEYS = ['from', 'to', 'page', 'pageSize'];

/**
 * The query of the insights read. `from` and `to` are Market days, both included; with neither
 * the range is the last 30 days ending today; at most 92 days. `page` starts at 1.
 */
export function parseInsightsQuery(
  query: Record<string, unknown>,
  today: Temporal.PlainDate,
): Result<InsightsQuery, readonly FieldError[]> {
  const errors: FieldError[] = [];
  for (const key of Object.keys(query)) {
    if (!QUERY_KEYS.includes(key)) errors.push({ path: key.slice(0, 32), code: 'format' });
  }
  const day = (name: 'from' | 'to', fallback: Temporal.PlainDate): Temporal.PlainDate => {
    const raw = query[name];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !DAY_FORMAT.test(raw)) {
      errors.push({ path: name, code: 'format' });
      return fallback;
    }
    try {
      return Temporal.PlainDate.from(raw, { overflow: 'reject' });
    } catch {
      errors.push({ path: name, code: 'format' });
      return fallback;
    }
  };
  const to = day('to', today);
  const from = day('from', to.subtract({ days: DEFAULT_INSIGHTS_DAYS - 1 }));
  if (errors.length === 0) {
    if (Temporal.PlainDate.compare(from, to) > 0) errors.push({ path: 'from', code: 'range' });
    else if (from.until(to, { largestUnit: 'days' }).days + 1 > MAX_INSIGHTS_DAYS) {
      errors.push({ path: 'to', code: 'range' });
    }
  }
  const number = (name: 'page' | 'pageSize', fallback: number, max: number): number => {
    const raw = query[name];
    if (raw === undefined) return fallback;
    const value = typeof raw === 'string' && /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : NaN;
    if (!(value >= 1 && value <= max)) {
      errors.push({ path: name, code: 'range' });
      return fallback;
    }
    return value;
  };
  const page = number('page', 1, 1000);
  const pageSize = number('pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return errors.length > 0
    ? { ok: false, error: errors }
    : { ok: true, value: { from, to, page, pageSize } };
}
