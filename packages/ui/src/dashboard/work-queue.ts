// The work queue of a panel's dashboard (dashboards upgrade phase 2, design section 2): the rows a
// panel builds from `GET dashboard/{admin/work-queue,seller/tasks}` and how they are grouped and
// put in order. Pure functions, shared by the "Needs action" card, the seller's "Today's tasks"
// card and the admin's full work-queue page.

export type WorkQueueLevel = 'critical' | 'today' | 'review';

export const WORK_QUEUE_LEVELS: readonly WorkQueueLevel[] = ['critical', 'today', 'review'];

/**
 * How a row says where it stands, besides its colour (Reza, UI/UX):
 * - `age`: "Overdue" when items are past their age limit, else "Oldest 3h".
 * - `deadline`: `oldestAt` is the nearest deadline (disputes): "Due in 6h", or "Overdue".
 * - `incident`: any item is an incident (halal listings without a valid certificate): "Incident".
 * - `fix`: a state the viewer must fix (the seller's payouts are paused): the queue's own words.
 */
export type WorkQueueSignal = 'age' | 'deadline' | 'incident' | 'fix';

export type WorkQueueState =
  | {
      readonly kind: 'ok';
      readonly count: number;
      /** Part of `count`. */
      readonly overdue: number;
      /** When the item that has waited longest came in (`deadline`: the nearest deadline). */
      readonly oldestAt: string | null;
    }
  /** The queue failed or was late: "Couldn't load", never 0. */
  | { readonly kind: 'error' };

export interface WorkQueueRow {
  readonly key: string;
  readonly label: string;
  /** The list of the queue; null while the panel has no list for it yet. */
  readonly href: string | null;
  readonly level: WorkQueueLevel;
  readonly signal: WorkQueueSignal;
  readonly state: WorkQueueState;
}

/** The body of `GET dashboard/admin/work-queue` and `GET dashboard/seller/tasks`. */
export interface WorkQueueAnswer {
  readonly panel: 'admin' | 'seller';
  readonly generatedAt: string;
  readonly queues: readonly WorkQueueItem[];
}

export interface WorkQueueItem {
  readonly key: string;
  readonly level: string;
  readonly status: string;
  readonly count?: number;
  readonly overdue?: number;
  readonly oldestAt?: string | null;
  readonly countedAt?: string;
}

/** What a panel knows of one queue key: its words, its list and how it signals. */
export interface WorkQueueDefinition {
  readonly label: string;
  readonly href: string | null;
  readonly signal: WorkQueueSignal;
}

const isLevel = (value: string): value is WorkQueueLevel =>
  (WORK_QUEUE_LEVELS as readonly string[]).includes(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The rows of an answer, in the API's order. A key the panel does not know (a queue added to the
 * API before the panel) or a malformed item is left out: the panel has no words or list for it.
 * An `ok` item without a valid count is shown as an error, never as 0.
 */
export function workQueueRows(
  answer: WorkQueueAnswer,
  define: (key: string) => WorkQueueDefinition | null,
): WorkQueueRow[] {
  const queues: unknown = answer.queues;
  if (!Array.isArray(queues)) return [];
  return (queues as readonly (WorkQueueItem | null)[]).flatMap((item): WorkQueueRow[] => {
    if (typeof item?.key !== 'string' || typeof item.level !== 'string') return [];
    if (!isLevel(item.level)) return [];
    const definition = define(item.key);
    if (definition === null) return [];
    const valid =
      item.status === 'ok' &&
      isCount(item.count) &&
      isCount(item.overdue) &&
      item.overdue <= item.count;
    const state: WorkQueueState = valid
      ? {
          kind: 'ok',
          count: item.count,
          overdue: item.overdue,
          oldestAt: typeof item.oldestAt === 'string' ? item.oldestAt : null,
        }
      : { kind: 'error' };
    return [{ key: item.key, level: item.level, ...definition, state }];
  });
}

/** True when the row has work in it, or could not be read (it is never folded into "All clear"). */
export function needsAction(row: WorkQueueRow): boolean {
  return row.state.kind === 'error' || row.state.count > 0;
}

const time = (iso: string | null): number => {
  if (iso === null) return Number.POSITIVE_INFINITY;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
};

/**
 * The urgency order within a level: a queue that could not be read first (its state is unknown),
 * then the most overdue items, then the oldest (or, for a deadline, the nearest), then the most
 * items; the API's order breaks a tie.
 */
export function byUrgency(rows: readonly WorkQueueRow[]): WorkQueueRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const sa = a.row.state;
      const sb = b.row.state;
      if (sa.kind !== sb.kind) return sa.kind === 'error' ? -1 : 1;
      if (sa.kind === 'ok' && sb.kind === 'ok') {
        if (sa.overdue !== sb.overdue) return sb.overdue - sa.overdue;
        const ta = time(sa.oldestAt);
        const tb = time(sb.oldestAt);
        if (ta !== tb) return ta - tb;
        if (sa.count !== sb.count) return sb.count - sa.count;
      }
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/** The tone of a row's dot and status text. A queue in its normal state is neutral (Jafar). */
export type WorkQueueTone = 'critical' | 'attention' | 'neutral';

/** Where a row stands, as the card shows it: the status words and their tone. */
export type WorkQueueStatus =
  | { readonly kind: 'error' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'incident' }
  | { readonly kind: 'fix' }
  | { readonly kind: 'overdue'; readonly minutes: number | null }
  | { readonly kind: 'due-in'; readonly minutes: number }
  | { readonly kind: 'oldest'; readonly minutes: number }
  | { readonly kind: 'waiting' };

const MINUTE_MS = 60_000;

/** Where the row stands at `now`. */
export function workQueueStatus(row: WorkQueueRow, now: number): WorkQueueStatus {
  const state = row.state;
  if (state.kind === 'error') return { kind: 'error' };
  if (state.count === 0) return { kind: 'clear' };
  const at = time(state.oldestAt);
  const known = Number.isFinite(at);
  if (row.signal === 'incident') return { kind: 'incident' };
  if (row.signal === 'fix') return { kind: 'fix' };
  if (row.signal === 'deadline') {
    if (known && at > now) return { kind: 'due-in', minutes: Math.ceil((at - now) / MINUTE_MS) };
    return { kind: 'overdue', minutes: known ? Math.floor((now - at) / MINUTE_MS) : null };
  }
  const age = known ? Math.max(0, Math.floor((now - at) / MINUTE_MS)) : null;
  if (state.overdue > 0) return { kind: 'overdue', minutes: age };
  return age === null ? { kind: 'waiting' } : { kind: 'oldest', minutes: age };
}

export function workQueueTone(status: WorkQueueStatus): WorkQueueTone {
  switch (status.kind) {
    case 'error':
    case 'incident':
    case 'overdue':
    case 'fix':
      return 'critical';
    case 'due-in':
      return 'attention';
    default:
      return 'neutral';
  }
}

/** A short age in the viewer's locale: "45m", "3h", "2d" (narrow units of Intl). */
export function shortAge(minutes: number, locale: string): string {
  const [value, unit] =
    minutes < 60
      ? [Math.max(1, minutes), 'minute']
      : minutes < 48 * 60
        ? [Math.floor(minutes / 60), 'hour']
        : [Math.floor(minutes / (24 * 60)), 'day'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(
    value,
  );
}

/** The rows of the card, grouped as design section 2 shows them. */
export interface WorkQueueGroups {
  /** Every critical queue with work in it (or that could not be read), most urgent first. */
  readonly critical: readonly WorkQueueRow[];
  /** The most urgent `today` queues, at most `todayLimit`. */
  readonly today: readonly WorkQueueRow[];
  /** The other `today` queues with work, folded into one line. */
  readonly todayMore: readonly WorkQueueRow[];
  /** Every review queue with work, folded into one line. */
  readonly review: readonly WorkQueueRow[];
  /** The queues with nothing in them ("All clear"). */
  readonly clear: readonly WorkQueueRow[];
}

/** The card's grouping: every critical queue, the top `todayLimit` today queues, review folded. */
export function groupWorkQueue(rows: readonly WorkQueueRow[], todayLimit = 5): WorkQueueGroups {
  const open = rows.filter(needsAction);
  const of = (level: WorkQueueLevel) => byUrgency(open.filter((row) => row.level === level));
  const today = of('today');
  return {
    critical: of('critical'),
    today: today.slice(0, todayLimit),
    todayMore: today.slice(todayLimit),
    review: of('review'),
    clear: rows.filter((row) => !needsAction(row)),
  };
}

/** The sum and the oldest item of folded rows; `failed` when one of them could not be read. */
export function foldRows(rows: readonly WorkQueueRow[]): {
  readonly count: number;
  readonly oldestAt: string | null;
  readonly failed: boolean;
} {
  let count = 0;
  let oldest: string | null = null;
  let failed = false;
  for (const row of rows) {
    if (row.state.kind === 'error') {
      failed = true;
      continue;
    }
    count += row.state.count;
    if (time(row.state.oldestAt) < time(oldest)) oldest = row.state.oldestAt;
  }
  return { count, oldestAt: oldest, failed };
}
