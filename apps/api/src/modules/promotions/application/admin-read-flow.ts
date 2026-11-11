import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AuditTrailRow } from '../../../platform/audit/audit-trail-reader';
import {
  DISPLAY_STATUSES,
  PROMOTION_VIEWS,
  displayStatusOf,
  type DisplayStatus,
} from '../domain/display-status';
import {
  PromotionBudgetChanged,
  PromotionCreated,
  PromotionEdited,
  PromotionPaused,
  PromotionResumed,
} from '../domain/audit';
import {
  CREATABLE_TYPES,
  FUNDINGS,
  type CreatableType,
  type FieldIssue,
  type Funding,
  type PromotionRecord,
} from '../domain/promotion';
import { adminAccountId } from './caller';
import type { PromotionsFailure } from './failures';
import { activeSettings } from './market-switch';
import type { OptInRecord } from './ports/opt-in.repository';
import {
  PROMOTION_SORTS,
  type PromotionSearch,
  type PromotionSort,
  type StatusCriterion,
  type UsageRecord,
} from './ports/promotion.repository';
import type { PromotionsDependencies } from './promotions-dependencies';
import { usageWithCredits } from './read-flow';
import { promotionViewOf, usageViewOf, type PromotionUsageView, type PromotionView } from './views';

// The admin's reads of the promotions list (search, tabs, paging), the activity of one promotion
// (from its audit rows), the sellers of a co-funded campaign, and the number of open review
// entries. All of them only read; the Viewer's list carries usage counts only, the rest needs
// `promotions.promotion.manage`.

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** Deepest page: a search is narrowed, not walked to the end. */
const MAX_PAGE = 1000;
const MAX_TEXT = 100;

export interface ListQuery {
  readonly text?: unknown;
  readonly type?: unknown;
  readonly owner?: unknown;
  readonly funding?: unknown;
  readonly status?: unknown;
  readonly view?: unknown;
  readonly sort?: unknown;
  readonly order?: unknown;
  readonly page?: unknown;
  readonly limit?: unknown;
}

/** The count of each tab for the same search (text, type, owner, funding), whatever the page. */
export type TabCounts = Readonly<Record<StatusCriterion | 'ALL', number>>;

export interface PromotionsPage<V> {
  readonly items: readonly (V & { readonly displayStatus: DisplayStatus })[];
  /** Matches of the whole search, not of this page. */
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly counts: TabCounts;
}

const enumValue = <T extends string>(raw: unknown, allowed: readonly T[]): T | null =>
  typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;

/** A whole number from a value that is a number or a string of digits. */
function wholeNumber(raw: unknown): number | null {
  const value = typeof raw === 'string' && /^[0-9]{1,6}$/.test(raw) ? Number(raw) : raw;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function searchOf(
  query: ListQuery,
  reviewPromotionIds: readonly Id<'Promotion'>[],
): Result<{ search: PromotionSearch; page: number }, PromotionsFailure> {
  const fields: FieldIssue[] = [];

  let text: string | null = null;
  if (query.text !== undefined) {
    if (typeof query.text !== 'string' || Array.from(query.text.trim()).length > MAX_TEXT) {
      fields.push({ path: 'text', code: 'value' });
    } else if (query.text.trim() !== '') {
      text = query.text.trim();
    }
  }

  const types: CreatableType[] = [];
  if (query.type !== undefined) {
    const parts = typeof query.type === 'string' ? query.type.split(',') : [];
    for (const part of parts) {
      const type = enumValue(part, CREATABLE_TYPES);
      if (type === null) {
        fields.push({ path: 'type', code: 'value' });
        break;
      }
      if (!types.includes(type)) types.push(type);
    }
    if (parts.length === 0) fields.push({ path: 'type', code: 'value' });
  }

  let owner: PromotionSearch['owner'] = null;
  if (query.owner !== undefined) {
    owner = enumValue(query.owner, ['PLATFORM', 'SELLER'] as const);
    if (owner === null) fields.push({ path: 'owner', code: 'value' });
  }

  let funding: Funding | null = null;
  if (query.funding !== undefined) {
    funding = enumValue(query.funding, FUNDINGS);
    if (funding === null) fields.push({ path: 'funding', code: 'value' });
  }

  // `view` is a tab and `status` a filter of the Status menu; they name the same thing, so one.
  let criterion: StatusCriterion | null = null;
  if (query.view !== undefined && query.status !== undefined) {
    fields.push({ path: 'status', code: 'conflict' });
  } else if (query.view !== undefined) {
    const view = enumValue(query.view, PROMOTION_VIEWS);
    if (view === null) fields.push({ path: 'view', code: 'value' });
    else criterion = view === 'ALL' ? null : view;
  } else if (query.status !== undefined) {
    criterion = enumValue(query.status, [...DISPLAY_STATUSES, 'NEEDS_REVIEW'] as const);
    if (criterion === null) fields.push({ path: 'status', code: 'value' });
  }

  let sort: PromotionSort = 'CREATED';
  if (query.sort !== undefined) {
    const parsed = enumValue(query.sort, PROMOTION_SORTS);
    if (parsed === null) fields.push({ path: 'sort', code: 'value' });
    else sort = parsed;
  }
  let descending = sort !== 'NAME';
  if (query.order !== undefined) {
    const order = enumValue(query.order, ['asc', 'desc'] as const);
    if (order === null) fields.push({ path: 'order', code: 'value' });
    else descending = order === 'desc';
  }

  let page = 1;
  if (query.page !== undefined) {
    const parsed = wholeNumber(query.page);
    if (parsed === null || parsed < 1 || parsed > MAX_PAGE)
      fields.push({ path: 'page', code: 'value' });
    else page = parsed;
  }
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = wholeNumber(query.limit);
    if (parsed === null || parsed < 1 || parsed > MAX_LIMIT) {
      fields.push({ path: 'limit', code: 'value' });
    } else {
      limit = parsed;
    }
  }

  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({
    page,
    search: {
      text,
      types,
      owner,
      funding,
      criterion,
      reviewPromotionIds,
      sort,
      descending,
      offset: (page - 1) * limit,
      limit,
    },
  });
}

const CRITERIA: readonly (StatusCriterion | 'ALL')[] = ['ALL', ...DISPLAY_STATUSES, 'NEEDS_REVIEW'];

/**
 * One page of the admin list with the number of matches and the count of every tab. `full`
 * carries terms, budget and money (manager); otherwise usage counts only (Viewer).
 */
export async function searchPromotions<V>(
  deps: PromotionsDependencies,
  context: CallContext,
  query: ListQuery,
  view: (record: PromotionRecord, usage: UsageRecord | undefined) => V,
): Promise<Result<PromotionsPage<V>, PromotionsFailure>> {
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  // Parse before the unit opens; the open review entries are read inside it, so parse twice is
  // avoided by validating with an empty id set first.
  const checked = searchOf(query, []);
  if (!checked.ok) return checked;
  return deps.unitOfWork.run<PromotionsPage<V>, PromotionsFailure>(
    context.market,
    async () => {
      const open = await deps.reviews.openSummary(context.market);
      const parsed = searchOf(query, open.promotionIds);
      if (!parsed.ok) return parsed;
      const { search, page } = parsed.value;
      const now = deps.clock.now();
      const found = await deps.promotions.search(context.market, search, now);
      const counted = await deps.promotions.countByCriterion(context.market, search, now);
      const ids = found.records.map((record) => record.id);
      const usage = await usageWithCredits(
        deps,
        context,
        found.records,
        await deps.promotions.usageOf(context.market, ids),
      );
      const counts = Object.fromEntries(
        CRITERIA.map((criterion) => [criterion, counted.get(criterion) ?? 0]),
      ) as TabCounts;
      return ok({
        items: found.records.map((record) => ({
          ...view(record, usage.get(record.id)),
          displayStatus: displayStatusOf(
            {
              type: record.type,
              status: record.status,
              startsAt: record.startsAt,
              endsAt: record.endsAt,
              budgetMinor: record.budgetMinor,
              spentMinor: usage.get(record.id)?.spentMinor ?? 0n,
            },
            now,
          ),
        })),
        total: found.total,
        page,
        limit: search.limit,
        counts,
      });
    },
    { readOnly: true },
  );
}

/** `promotions.promotion.view`: the list with usage counts only. */
export const searchUsage = (deps: PromotionsDependencies, context: CallContext, query: ListQuery) =>
  searchPromotions<PromotionUsageView>(deps, context, query, usageViewOf);

/** `promotions.promotion.manage`: the list with terms, budget and the money used. */
export function searchFull(
  deps: PromotionsDependencies,
  context: CallContext,
  query: ListQuery,
): Promise<Result<PromotionsPage<PromotionView>, PromotionsFailure>> {
  if (adminAccountId(context) === null) return Promise.resolve(err({ code: 'access.denied' }));
  return searchPromotions<PromotionView>(deps, context, query, promotionViewOf);
}

// ---- Open review entries ----

/** `promotions.promotion.manage`: how many entries of the review queue are open (for a tab or a menu badge). */
export async function countOpenReviews(
  deps: PromotionsDependencies,
  context: CallContext,
): Promise<Result<{ readonly open: number }, PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  return deps.unitOfWork.run<{ readonly open: number }, PromotionsFailure>(
    context.market,
    async () => ok({ open: (await deps.reviews.openSummary(context.market)).count }),
    { readOnly: true },
  );
}

// ---- Members of a co-funded campaign ----

export interface CampaignMembers {
  readonly promotionId: Id<'Promotion'>;
  /** The platform's share of what a use costs, in basis points; the sellers pay the rest. */
  readonly platformSplitBps: number | null;
  /** Oldest opt-in first; withdrawn ones are kept with their date. */
  readonly members: readonly OptInRecord[];
  /** The sellers with a live opt-in. */
  readonly liveCount: number;
}

/**
 * The sellers that opted in to a co-funded campaign (and those that withdrew). Seller names are not
 * here: `sellers` gives an admin no name through its facade, the panel names them from its own
 * seller reads.
 */
export async function campaignMembers(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly promotionId?: unknown },
): Promise<Result<CampaignMembers, PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const id =
    typeof input?.promotionId === 'string' ? parseId<'Promotion'>(input.promotionId) : null;
  if (id === null || !id.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'promotionId', code: 'value' }] });
  }
  return deps.unitOfWork.run<CampaignMembers, PromotionsFailure>(
    context.market,
    async () => {
      const record = await deps.promotions.find(context.market, id.value);
      if (record === null) return err({ code: 'promotions.not-found' });
      // Only a co-funded campaign has members.
      if (record.funding !== 'CO_FUNDED') return err({ code: 'promotions.invalid-state' });
      const members = await deps.optIns.listOf(context.market, record.id);
      return ok({
        promotionId: record.id,
        platformSplitBps: record.platformSplitBps,
        members,
        liveCount: members.filter((member) => member.withdrawnAt === null).length,
      });
    },
    { readOnly: true },
  );
}

// ---- Activity of one promotion ----

export const ACTIVITY_ACTIONS = [
  PromotionCreated,
  PromotionEdited,
  PromotionPaused,
  PromotionResumed,
  PromotionBudgetChanged,
] as const;

const ACTION_NAMES = new Map<string, ActivityKind>([
  [PromotionCreated.action, 'created'],
  [PromotionEdited.action, 'edited'],
  [PromotionPaused.action, 'paused'],
  [PromotionResumed.action, 'resumed'],
  [PromotionBudgetChanged.action, 'budget-changed'],
]);

export type ActivityKind = 'created' | 'edited' | 'paused' | 'resumed' | 'budget-changed';

/** A value an audit side holds that is safe to show: a scalar, or an amount with its currency. */
export type ActivityValue =
  string | number | boolean | null | { readonly amount: string; readonly currency: string };

export interface ActivityChange {
  readonly field: string;
  readonly before: ActivityValue;
  readonly after: ActivityValue;
}

export interface ActivityItem {
  /** The audit row's id, also the cursor of the next page. */
  readonly id: string;
  readonly at: Temporal.Instant;
  readonly kind: ActivityKind;
  /** The name when identity may give it; null for a job or an account that cannot be named. */
  readonly byDisplayName: string | null;
  readonly byKind: 'member' | 'platform' | 'system';
  readonly changes: readonly ActivityChange[];
}

export interface ActivityPage {
  readonly items: readonly ActivityItem[];
  readonly next: string | null;
}

/** Keys of an audit side that are proofs and versions, not terms. */
const NOT_A_TERM = new Set(['version', 'stepUpSessionId', 'stepUpVerifiedAt']);
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_CHANGES = 32;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function shown(value: unknown): ActivityValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    (typeof value.amount === 'string' || typeof value.amount === 'bigint') &&
    typeof value.currency === 'string'
  ) {
    return { amount: String(value.amount), currency: value.currency };
  }
  // Anything else (a nested object, a list) is not something the panel needs to show.
  return null;
}

/** A value as text for comparing two sides; an amount held as a bigint compares as digits. */
const stable = (value: unknown): string =>
  JSON.stringify(value ?? null, (_key, inner: unknown) =>
    typeof inner === 'bigint' ? inner.toString() : inner,
  );

/** The terms that differ between the two sides of a row (a missing side is empty). */
export function changesOf(before: unknown, after: unknown): readonly ActivityChange[] {
  const left = isRecord(before) ? before : {};
  const right = isRecord(after) ? after : {};
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((name) => !NOT_A_TERM.has(name) && FIELD_NAME.test(name))
    .sort();
  const changes: ActivityChange[] = [];
  for (const field of names) {
    if (stable(left[field]) === stable(right[field])) continue;
    changes.push({ field, before: shown(left[field]), after: shown(right[field]) });
  }
  return changes.slice(0, MAX_CHANGES);
}

const ACTIVITY_PAGE = 20;
const MAX_ACTIVITY_PAGE = 50;

/**
 * The create, edit, pause, resume and budget changes of one promotion, newest first, from its audit
 * rows: who (named only as identity allows), when, and which terms changed from what to what. A
 * step-up proof never shows. Needs the manager permission; a seller's promotion is readable too,
 * since an admin may pause or reject it.
 */
export async function promotionActivity(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly promotionId?: unknown; readonly after?: unknown; readonly limit?: unknown },
): Promise<Result<ActivityPage, PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const fields: FieldIssue[] = [];
  const id =
    typeof input?.promotionId === 'string' ? parseId<'Promotion'>(input.promotionId) : null;
  if (id === null || !id.ok) fields.push({ path: 'promotionId', code: 'value' });
  let limit = ACTIVITY_PAGE;
  if (input?.limit !== undefined) {
    const parsed = wholeNumber(input.limit);
    if (parsed === null || parsed < 1 || parsed > MAX_ACTIVITY_PAGE) {
      fields.push({ path: 'limit', code: 'value' });
    } else {
      limit = parsed;
    }
  }
  let after: string | null = null;
  if (input?.after !== undefined && input.after !== null) {
    const parsed = typeof input.after === 'string' ? parseId(input.after) : null;
    if (parsed === null || !parsed.ok) fields.push({ path: 'after', code: 'value' });
    else after = parsed.value;
  }
  if (fields.length > 0 || id === null || !id.ok) return err({ code: 'validation.failed', fields });

  const read = await deps.unitOfWork.run<readonly AuditTrailRow[], PromotionsFailure>(
    context.market,
    async () => {
      const record = await deps.promotions.find(context.market, id.value);
      if (record === null) return err({ code: 'promotions.not-found' });
      const history = await deps.auditTrail.historyOf(context.market, {
        actions: ACTIVITY_ACTIONS.map((action) => action.action),
        targetId: id.value,
        after,
        // One more than the page tells whether another page exists.
        limit: limit + 1,
      });
      if (!history.ok) {
        return err({
          code: 'validation.failed',
          fields: [{ path: 'after', code: 'unknown' }],
        });
      }
      return ok(history.value);
    },
    { readOnly: true },
  );
  if (!read.ok) return read;

  const rows = read.value.slice(0, limit);
  const accountIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.actorType === 'USER' && row.actorId !== null ? [row.actorId] : [],
      ),
    ),
  ];
  // Names come after the unit closes. When identity cannot answer, the page still shows, unnamed.
  let labels: ReadonlyMap<string, { kind: 'member' | 'platform'; displayName: string | null }> =
    new Map();
  if (accountIds.length > 0) {
    try {
      labels = await deps.actors.labelsOf(context, accountIds);
    } catch {
      labels = new Map();
    }
  }
  return ok({
    items: rows.flatMap((row) => {
      const kind = ACTION_NAMES.get(row.action);
      if (kind === undefined) return [];
      const label = row.actorId === null ? undefined : labels.get(row.actorId);
      const system = row.actorType !== 'USER' || row.actorId === null;
      return [
        {
          id: row.id,
          at: row.occurredAt,
          kind,
          byDisplayName: system ? null : (label?.displayName ?? null),
          byKind: system ? ('system' as const) : (label?.kind ?? ('member' as const)),
          changes: changesOf(row.before, row.after),
        },
      ];
    }),
    next: read.value.length > limit ? rows[rows.length - 1]!.id : null,
  });
}
