import { parseId } from '@mondapac/shared-kernel';
import type { Id, Temporal } from '@mondapac/shared-kernel';

// Block counts (personalization package 1d-3, part B). How often each storefront block (a module
// placement on a published page) was shown and clicked, as two numbers per (Market, page,
// placement, UTC day). Aggregate only: an event is never stored, and nothing identifies who sent
// it (no account, guest token, cookie, IP address or user agent is read or kept).

export const BLOCK_EVENT_TYPES = ['impression', 'click'] as const;
export type BlockEventType = (typeof BLOCK_EVENT_TYPES)[number];

/** The most events one request may carry. */
export const MAX_BLOCK_EVENTS = 20;

/**
 * The most distinct pages one request may name: a beacon reports one page view (storefront is
 * asked once per distinct page), so a request cannot fan out into many storefront reads.
 */
export const MAX_BLOCK_PAGES = 2;

/** How long the daily counts are kept: older rows are deleted by the daily purge. */
export const BLOCK_COUNT_RETENTION = { months: 13 } as const;

/** The only field of the request body. */
export const BLOCK_REQUEST_FIELDS: readonly string[] = ['events'];
/** The fields of one event; any other is refused. */
export const BLOCK_EVENT_FIELDS: readonly string[] = ['pageId', 'placementId', 'type'];

/** One reported event: a block of a page was shown or clicked. */
export interface BlockEvent {
  readonly pageId: Id<'StorefrontPage'>;
  readonly placementId: Id<'StorefrontPlacement'>;
  readonly type: BlockEventType;
}

export interface BlockFieldProblem {
  readonly path: string;
  readonly code: string;
}

const isEventType = (value: unknown): value is BlockEventType =>
  typeof value === 'string' && (BLOCK_EVENT_TYPES as readonly string[]).includes(value);

/**
 * Reads the `events` of a request body: 1 to {@link MAX_BLOCK_EVENTS} closed objects, each with a
 * canonical UUIDv7 `pageId` and `placementId` and a `type` of {@link BLOCK_EVENT_TYPES}. Identical
 * events of one request count once (order of first appearance kept). A problem names the event by
 * its index and never repeats a value or an unknown key.
 */
export function readBlockEvents(
  events: unknown,
):
  | { readonly ok: true; readonly events: readonly BlockEvent[] }
  | { readonly ok: false; readonly fields: BlockFieldProblem[] } {
  if (events === undefined) return { ok: false, fields: [{ path: 'events', code: 'required' }] };
  if (!Array.isArray(events)) return { ok: false, fields: [{ path: 'events', code: 'type' }] };
  if (events.length < 1) return { ok: false, fields: [{ path: 'events', code: 'too-few' }] };
  if (events.length > MAX_BLOCK_EVENTS) {
    return { ok: false, fields: [{ path: 'events', code: 'too-many' }] };
  }

  const fields: BlockFieldProblem[] = [];
  const seen = new Set<string>();
  const kept: BlockEvent[] = [];
  events.forEach((entry: unknown, index) => {
    const at = (name: string) => `events.${index}.${name}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fields.push({ path: `events.${index}`, code: 'type' });
      return;
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => !BLOCK_EVENT_FIELDS.includes(key))) {
      fields.push({ path: `events.${index}`, code: 'unknown-field' });
    }
    const pageId = idOf<'StorefrontPage'>(record.pageId, at('pageId'), fields);
    const placementId = idOf<'StorefrontPlacement'>(record.placementId, at('placementId'), fields);
    const type = record.type;
    if (type === undefined) fields.push({ path: at('type'), code: 'required' });
    else if (!isEventType(type)) fields.push({ path: at('type'), code: 'one-of' });
    if (pageId === null || placementId === null || !isEventType(type)) return;
    const key = `${pageId}|${placementId}|${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    kept.push({ pageId, placementId, type });
  });
  if (
    fields.length === 0 &&
    new Set(events.map((e) => (e as BlockEvent).pageId)).size > MAX_BLOCK_PAGES
  ) {
    return { ok: false, fields: [{ path: 'events', code: 'too-many-pages' }] };
  }
  return fields.length > 0 ? { ok: false, fields } : { ok: true, events: kept };
}

function idOf<K extends string>(
  value: unknown,
  path: string,
  fields: BlockFieldProblem[],
): Id<K> | null {
  if (value === undefined || value === null) {
    fields.push({ path, code: 'required' });
    return null;
  }
  const parsed = parseId<K>(value as string);
  if (!parsed.ok) {
    fields.push({ path, code: 'format' });
    return null;
  }
  return parsed.value;
}

/** The UTC calendar day an event is counted on. */
export const blockCountDay = (now: Temporal.Instant): Temporal.PlainDate =>
  now.toZonedDateTimeISO('UTC').toPlainDate();

/** Rows of a day before this one are past their retention (13 months on the UTC calendar). */
export const blockCountRetentionEdge = (now: Temporal.Instant): Temporal.PlainDate =>
  blockCountDay(now).subtract(BLOCK_COUNT_RETENTION);

/** The counts one request adds to one block on one day. */
export interface BlockCountIncrement {
  readonly pageId: Id<'StorefrontPage'>;
  readonly placementId: Id<'StorefrontPlacement'>;
  readonly impressions: number;
  readonly clicks: number;
}

/** Groups the events by block, ordered by (page, placement) so concurrent requests lock alike. */
export function incrementsOf(events: readonly BlockEvent[]): BlockCountIncrement[] {
  const byBlock = new Map<
    string,
    { -readonly [K in keyof BlockCountIncrement]: BlockCountIncrement[K] }
  >();
  for (const event of events) {
    const key = `${event.pageId}|${event.placementId}`;
    const row = byBlock.get(key) ?? {
      pageId: event.pageId,
      placementId: event.placementId,
      impressions: 0,
      clicks: 0,
    };
    if (event.type === 'impression') row.impressions += 1;
    else row.clicks += 1;
    byBlock.set(key, row);
  }
  return [...byBlock.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);
}
