import { ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  MarketContext,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type {
  ConsumedStepUp,
  StepUpProofConsumer,
  StepUpRefusal,
} from '../../../../platform/authz';
import type {
  RevertOutcome,
  RevertRequest,
  SystemChangeReverter,
} from '../../../../platform/change-review/change-review';
import type { PolicyArea, ReviewArea, Risk } from '../../domain/areas';
import { dueForReminder } from '../../domain/overdue';
import type { SystemRequest } from '../../domain/request';
import type { AdminNames } from '../ports/admin-names';
import type {
  AreaPolicyRecord,
  DueDaysRecord,
  PolicyRepository,
  Stamp,
} from '../ports/policy.repository';
import type {
  ActivityRecord,
  DecisionWrite,
  Direction,
  NewRequest,
  PageWindow,
  RequestFilter,
  RequestRepository,
  RequestSort,
} from '../ports/request.repository';

// In-memory ports of system-requests for the application specs. They keep each Market apart as
// the Prisma repositories do (every read and write is keyed by the Market).

type Stored = SystemRequest & { readonly market: string };

const sortValue = (request: SystemRequest, sort: RequestSort): number =>
  sort === 'applied'
    ? request.appliedAt.epochMilliseconds
    : sort === 'due'
      ? request.reviewDueAt.epochMilliseconds
      : request.number;

function matches(request: SystemRequest, filter: RequestFilter): boolean {
  if (filter.statuses !== undefined && !filter.statuses.includes(request.status)) return false;
  if (filter.areas !== undefined && !filter.areas.includes(request.area)) return false;
  if (filter.risks !== undefined && !filter.risks.includes(request.risk)) return false;
  if (filter.requestedBy !== undefined && request.requestedBy !== filter.requestedBy) return false;
  if (filter.notRequestedBy !== undefined && request.requestedBy === filter.notRequestedBy) {
    return false;
  }
  if (filter.decidedBy !== undefined && request.decidedBy !== filter.decidedBy) return false;
  const applied = request.appliedAt.epochMilliseconds;
  if (filter.appliedFrom !== undefined && applied < filter.appliedFrom.epochMilliseconds) {
    return false;
  }
  if (filter.appliedBefore !== undefined && applied >= filter.appliedBefore.epochMilliseconds) {
    return false;
  }
  if (
    filter.dueBy !== undefined &&
    (request.status !== 'open' ||
      request.reviewDueAt.epochMilliseconds > filter.dueBy.epochMilliseconds)
  ) {
    return false;
  }
  if (filter.subjectKind !== undefined && request.subjectKind !== filter.subjectKind) return false;
  if (filter.subjectRef !== undefined && request.subjectRef !== filter.subjectRef) return false;
  if (filter.number !== undefined && request.number !== filter.number) return false;
  if (filter.text !== undefined) {
    const needle = filter.text.toLowerCase();
    const hay = [request.note, request.subjectKind, request.subjectRef].map((s) => s.toLowerCase());
    if (!hay.some((s) => s.includes(needle))) return false;
  }
  return true;
}

export class InMemoryRequests implements RequestRepository {
  readonly rows: Stored[] = [];
  readonly lines: (ActivityRecord & { readonly market: string; readonly requestId: string })[] = [];
  readonly counters = new Map<string, number>();
  readonly locked: string[] = [];
  /** `last_reminded_at` by request id. */
  readonly reminded = new Map<string, Temporal.Instant>();

  private index(market: MarketContext, id: Id<'SystemRequest'>): number {
    return this.rows.findIndex((row) => row.market === market.marketId && row.id === id);
  }

  private plain(stored: Stored): SystemRequest {
    const { market, ...request } = stored;
    void market;
    return request;
  }

  open(market: MarketContext, request: NewRequest, activityId: Id<'SystemRequestActivity'>) {
    const number = (this.counters.get(market.marketId) ?? 0) + 1;
    this.counters.set(market.marketId, number);
    const superseded: Id<'SystemRequest'>[] = [];
    this.rows.forEach((row, at) => {
      if (
        row.market === market.marketId &&
        row.subjectKind === request.subjectKind &&
        row.subjectRef === request.subjectRef &&
        row.supersededBy === null
      ) {
        superseded.push(row.id);
        this.rows[at] = { ...row, supersededBy: request.id };
      }
    });
    this.rows.push({
      market: market.marketId,
      ...request,
      number,
      status: 'open',
      decision: null,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      supersededBy: null,
      commentCount: 0,
    });
    this.lines.push({
      market: market.marketId,
      requestId: request.id,
      id: activityId,
      kind: 'applied',
      actor: request.requestedBy,
      at: request.appliedAt,
      body: null,
    });
    return Promise.resolve({ number, superseded });
  }

  find(market: MarketContext, id: Id<'SystemRequest'>) {
    const at = this.index(market, id);
    return Promise.resolve(at < 0 ? null : this.plain(this.rows[at]!));
  }

  findForUpdate(market: MarketContext, id: Id<'SystemRequest'>) {
    this.locked.push(id);
    return this.find(market, id);
  }

  findMany(market: MarketContext, ids: readonly Id<'SystemRequest'>[]) {
    return Promise.resolve(
      this.rows
        .filter((row) => row.market === market.marketId && ids.includes(row.id))
        .map((row) => this.plain(row)),
    );
  }

  release(market: MarketContext, newer: Id<'SystemRequest'>) {
    const at = this.index(market, newer);
    if (at < 0 || this.rows[at]!.status !== 'reverted') {
      throw new Error('InMemoryRequests: only a reverted request releases (database guard)');
    }
    const released: Id<'SystemRequest'>[] = [];
    this.rows.forEach((row, index) => {
      if (row.market === market.marketId && row.supersededBy === newer) {
        released.push(row.id);
        this.rows[index] = { ...row, supersededBy: null };
      }
    });
    return Promise.resolve(released);
  }

  decide(market: MarketContext, id: Id<'SystemRequest'>, decision: DecisionWrite) {
    const at = this.index(market, id);
    if (at < 0 || this.rows[at]!.status !== 'open') return Promise.resolve(false);
    this.rows[at] = {
      ...this.rows[at]!,
      status: decision.status,
      decision: decision.decision,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      decisionReason: decision.reason,
    };
    return Promise.resolve(true);
  }

  addActivity(market: MarketContext, requestId: Id<'SystemRequest'>, activity: ActivityRecord) {
    this.lines.push({ market: market.marketId, requestId, ...activity });
    return Promise.resolve();
  }

  addComment(market: MarketContext, requestId: Id<'SystemRequest'>, activity: ActivityRecord) {
    this.lines.push({ market: market.marketId, requestId, ...activity });
    const at = this.index(market, requestId);
    const commentCount = this.rows[at]!.commentCount + 1;
    this.rows[at] = { ...this.rows[at]!, commentCount };
    return Promise.resolve(commentCount);
  }

  activity(market: MarketContext, id: Id<'SystemRequest'>) {
    return Promise.resolve(
      this.lines
        .filter((line) => line.market === market.marketId && line.requestId === id)
        .map((line) => ({
          id: line.id,
          kind: line.kind,
          actor: line.actor,
          at: line.at,
          body: line.body,
        })),
    );
  }

  page(
    market: MarketContext,
    filter: RequestFilter,
    sort: RequestSort,
    direction: Direction,
    window: PageWindow,
  ) {
    const sign = direction === 'asc' ? 1 : -1;
    const sorted = this.rows
      .filter((row) => row.market === market.marketId && matches(row, filter))
      .sort(
        (a, b) => sign * (sortValue(a, sort) - sortValue(b, sort)) || sign * (a.number - b.number),
      );
    let from = sorted;
    if (window.kind === 'keyset' && window.after !== null) {
      const after = window.after;
      const value = typeof after.value === 'number' ? after.value : after.value.epochMilliseconds;
      from = sorted.filter((row) => {
        const own = sortValue(row, sort);
        return (
          sign * (own - value) > 0 || (own === value && sign * (row.number - after.number) > 0)
        );
      });
    }
    const start = window.kind === 'offset' ? window.offset : 0;
    return Promise.resolve(from.slice(start, start + window.limit).map((row) => this.plain(row)));
  }

  dueForReminder(
    market: MarketContext,
    query: {
      readonly now: Temporal.Instant;
      readonly remindedBefore: Temporal.Instant;
      readonly areas: readonly ReviewArea[];
      readonly limit: number;
    },
  ) {
    return Promise.resolve(
      this.rows
        .filter(
          (row) =>
            row.market === market.marketId &&
            query.areas.includes(row.area) &&
            dueForReminder(
              { ...row, lastRemindedAt: this.reminded.get(row.id) ?? null },
              query.now,
              query.remindedBefore,
            ),
        )
        .sort(
          (a, b) =>
            a.reviewDueAt.epochMilliseconds - b.reviewDueAt.epochMilliseconds ||
            a.number - b.number,
        )
        .slice(0, query.limit)
        .map((row) => this.plain(row)),
    );
  }

  markReminded(
    market: MarketContext,
    id: Id<'SystemRequest'>,
    at: Temporal.Instant,
    remindedBefore: Temporal.Instant,
  ) {
    const at0 = this.index(market, id);
    const last = this.reminded.get(id) ?? null;
    if (
      at0 < 0 ||
      this.rows[at0]!.status !== 'open' ||
      (last !== null && last.epochMilliseconds >= remindedBefore.epochMilliseconds)
    ) {
      return Promise.resolve(false);
    }
    this.reminded.set(id, at);
    return Promise.resolve(true);
  }

  count(market: MarketContext, filter: RequestFilter, cap: number) {
    const found = this.rows.filter(
      (row) => row.market === market.marketId && matches(row, filter),
    ).length;
    return Promise.resolve(Math.min(found, cap));
  }
}

export class InMemoryPolicy implements PolicyRepository {
  readonly areaRows = new Map<string, AreaPolicyRecord>();
  readonly dueRows = new Map<string, DueDaysRecord>();

  areas(market: MarketContext) {
    return Promise.resolve(
      [...this.areaRows.entries()]
        .filter(([key]) => key.startsWith(`${market.marketId}:`))
        .map(([, row]) => row),
    );
  }

  area(market: MarketContext, area: PolicyArea) {
    return Promise.resolve(this.areaRows.get(`${market.marketId}:${area}`) ?? null);
  }

  setArea(
    market: MarketContext,
    area: PolicyArea,
    value: { readonly enabled: boolean; readonly risk: Risk },
    stamp: Stamp,
  ) {
    const key = `${market.marketId}:${area}`;
    if ((this.areaRows.get(key)?.version ?? 0) !== stamp.version - 1) return Promise.resolve(false);
    this.areaRows.set(key, {
      area,
      ...value,
      version: stamp.version,
      updatedAt: stamp.at,
      updatedBy: stamp.by,
    });
    return Promise.resolve(true);
  }

  dueDays(market: MarketContext) {
    return Promise.resolve(this.dueRows.get(market.marketId) ?? null);
  }

  setDueDays(market: MarketContext, days: number, stamp: Stamp) {
    if ((this.dueRows.get(market.marketId)?.version ?? 0) !== stamp.version - 1) {
      return Promise.resolve(false);
    }
    this.dueRows.set(market.marketId, {
      reviewDueDays: days,
      version: stamp.version,
      updatedAt: stamp.at,
      updatedBy: stamp.by,
    });
    return Promise.resolve(true);
  }
}

/** A step-up port that hands out a proof only when the test granted one, once. */
export class FakeStepUp implements StepUpProofConsumer {
  constructor(private readonly clock: Clock) {}
  readonly granted = new Set<string>();
  readonly spent: { readonly account: string; readonly action: string }[] = [];

  grant(account: Id<'Account'>, action: string): void {
    this.granted.add(`${account}:${action}`);
  }

  consume(context: CallContext, actionKey: string): Promise<Result<ConsumedStepUp, StepUpRefusal>> {
    const actor = context.actor;
    const account = actor.kind === 'authenticated' ? actor.accountId : 'none';
    const key = `${account}:${actionKey}`;
    if (!this.granted.delete(key) || actor.kind !== 'authenticated') {
      return Promise.resolve({ ok: false, error: { code: 'second-factor.required', actionKey } });
    }
    this.spent.push({ account, action: actionKey });
    return Promise.resolve(ok({ sessionId: actor.sessionId, verifiedAt: this.clock.now() }));
  }
}

/**
 * Another module's subject held in memory (a setting's value per Market), with the reverter that
 * owning module would register: it restores `before` only while the subject still holds `after`.
 */
export class FakeSubjects implements SystemChangeReverter {
  readonly values = new Map<string, Readonly<Record<string, unknown>>>();
  readonly reverts: RevertRequest[] = [];
  /** Refs whose revert the owning module refuses the decider (`not-permitted`). */
  readonly refused = new Set<string>();
  /** `account:ref` pairs where the account has a stake in the subject (separation of duties). */
  readonly interested = new Set<string>();
  /** Refs whose pre-unit `check` refuses the decider; every check asked is kept in `checks`. */
  readonly checkRefused = new Set<string>();
  readonly checks: RevertRequest[] = [];

  check(_context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'> {
    this.checks.push(request);
    return Promise.resolve(this.checkRefused.has(request.subjectRef) ? 'not-permitted' : 'ok');
  }

  /** The labels the owning module would give, per Market and ref. */
  readonly labels = new Map<string, string>();
  readonly described: (readonly string[])[] = [];
  describeFails = false;

  set(market: string, ref: string, value: Readonly<Record<string, unknown>>): void {
    this.values.set(`${market}:${ref}`, value);
  }

  get(market: string, ref: string): Readonly<Record<string, unknown>> | undefined {
    return this.values.get(`${market}:${ref}`);
  }

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    this.reverts.push(request);
    const key = `${context.market.marketId}:${request.subjectRef}`;
    const current = this.values.get(key);
    if (current === undefined) return Promise.resolve('gone');
    if (this.refused.has(request.subjectRef)) return Promise.resolve('not-permitted');
    if (JSON.stringify(current) !== JSON.stringify(request.after)) {
      return Promise.resolve('changed-since');
    }
    this.values.set(key, request.before);
    return Promise.resolve('reverted');
  }

  isInterested(context: CallContext, request: RevertRequest): Promise<boolean> {
    const actor = context.actor;
    const account = actor.kind === 'authenticated' ? actor.accountId : '';
    return Promise.resolve(this.interested.has(`${account}:${request.subjectRef}`));
  }

  describe(context: CallContext, subjectRefs: readonly string[]) {
    this.described.push([...subjectRefs]);
    if (this.describeFails) return Promise.reject(new Error('down'));
    const found = new Map<string, string>();
    for (const ref of subjectRefs) {
      const label = this.labels.get(`${context.market.marketId}:${ref}`);
      if (label !== undefined) found.set(ref, label);
    }
    return Promise.resolve(found);
  }
}

/** Admin names in memory: the names it was given; `refusing` answers none (a refused read). */
export class FakeAdminNames implements AdminNames {
  refusing = false;
  readonly asked: (readonly string[])[] = [];
  constructor(private readonly names: Readonly<Record<string, string>> = {}) {}

  namesOf(_context: CallContext, accountIds: readonly string[]) {
    this.asked.push([...accountIds]);
    if (this.refusing) return Promise.resolve(new Map<string, string>());
    return Promise.resolve(
      new Map(accountIds.flatMap((id) => (this.names[id] ? [[id, this.names[id]] as const] : []))),
    );
  }
}
