import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { CustomerGroup, CustomerGroupWithCount } from '../../domain/customer-groups';
import type { StoredCustomerNote } from '../../domain/customer-note';
import type { TimelineEntry } from '../../domain/customer-timeline';
import type { CustomerGroupRepository, GroupChange } from '../ports/customer-groups.repository';
import type {
  CustomerNoteCipher,
  CustomerNoteRepository,
  NoteKeyDestroyed,
} from '../ports/customer-notes.repository';
import type {
  CustomerTimelineRepository,
  TimelineQuery,
} from '../ports/customer-timeline.repository';
import type { InMemoryCustomerList } from './in-memory-customer-list';

// In-memory stand-ins for the phase 2 management ports (unit tests). Each keeps one store per
// Market, so a test can show that another Market's rows are never reached. Group membership is
// written onto the list rows too, so the list's `group` filter and `groups` column see it.

const key = (market: MarketContext, id: string) => `${market.marketId}:${id}`;

export class InMemoryCustomerGroups implements CustomerGroupRepository {
  readonly groups = new Map<string, CustomerGroup>();
  readonly members = new Map<string, Set<Id<'Account'>>>();

  constructor(private readonly directory: InMemoryCustomerList) {}

  #withCount(market: MarketContext, group: CustomerGroup): CustomerGroupWithCount {
    return { ...group, memberCount: this.members.get(key(market, group.id))?.size ?? 0 };
  }

  #ofMarket(market: MarketContext): CustomerGroup[] {
    return [...this.groups.entries()]
      .filter(([k]) => k.startsWith(`${market.marketId}:`))
      .map(([, group]) => group);
  }

  #syncRows(market: MarketContext): void {
    const rows = this.directory.rowsOf.get(market.marketId) ?? [];
    this.directory.rowsOf.set(
      market.marketId,
      rows.map((row) => ({
        ...row,
        groups: this.#ofMarket(market)
          .filter((group) => this.members.get(key(market, group.id))?.has(row.accountId))
          .map((group) => ({
            groupId: group.id,
            name: group.name,
            archived: group.archivedAt !== null,
          })),
      })),
    );
  }

  list(market: MarketContext): Promise<readonly CustomerGroupWithCount[]> {
    const all = this.#ofMarket(market).sort((a, b) => {
      const live = Number(a.archivedAt !== null) - Number(b.archivedAt !== null);
      return live !== 0 ? live : Temporal.Instant.compare(b.createdAt, a.createdAt);
    });
    return Promise.resolve(all.map((group) => this.#withCount(market, group)));
  }

  find(market: MarketContext, id: Id<'CustomerGroup'>): Promise<CustomerGroupWithCount | null> {
    const group = this.groups.get(key(market, id));
    return Promise.resolve(group === undefined ? null : this.#withCount(market, group));
  }

  count(market: MarketContext): Promise<number> {
    return Promise.resolve(this.#ofMarket(market).length);
  }

  #nameTaken(market: MarketContext, name: string, except: string | null): boolean {
    return this.#ofMarket(market).some(
      (group) => group.id !== except && group.name.toLowerCase() === name.toLowerCase(),
    );
  }

  insert(market: MarketContext, group: CustomerGroup): Promise<'ok' | 'name-taken'> {
    if (this.#nameTaken(market, group.name, null)) return Promise.resolve('name-taken');
    this.groups.set(key(market, group.id), group);
    return Promise.resolve('ok');
  }

  update(market: MarketContext, change: GroupChange): Promise<'ok' | 'stale' | 'name-taken'> {
    const group = this.groups.get(key(market, change.id));
    if (group === undefined || group.version !== change.expectedVersion) {
      return Promise.resolve('stale');
    }
    if (this.#nameTaken(market, change.name, change.id)) return Promise.resolve('name-taken');
    this.groups.set(key(market, change.id), {
      ...group,
      name: change.name,
      description: change.description,
      archivedAt: change.archivedAt,
      updatedAt: change.updatedAt,
      version: group.version + 1,
    });
    this.#syncRows(market);
    return Promise.resolve('ok');
  }

  async addMembers(
    market: MarketContext,
    groupId: Id<'CustomerGroup'>,
    accountIds: readonly Id<'Account'>[],
  ): Promise<readonly Id<'Account'>[]> {
    const known = new Set(
      (await this.directory.rowsByIds(market, accountIds)).map((row) => row.accountId),
    );
    const set = this.members.get(key(market, groupId)) ?? new Set<Id<'Account'>>();
    const added: Id<'Account'>[] = [];
    for (const id of new Set(accountIds)) {
      if (known.has(id) && !set.has(id)) {
        set.add(id);
        added.push(id);
      }
    }
    this.members.set(key(market, groupId), set);
    this.#syncRows(market);
    return added;
  }

  removeMembers(
    market: MarketContext,
    groupId: Id<'CustomerGroup'>,
    accountIds: readonly Id<'Account'>[],
  ): Promise<readonly Id<'Account'>[]> {
    const set = this.members.get(key(market, groupId)) ?? new Set<Id<'Account'>>();
    const removed = [...new Set(accountIds)].filter((id) => set.delete(id));
    this.#syncRows(market);
    return Promise.resolve(removed);
  }

  groupsOf(
    market: MarketContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<
    ReadonlyMap<
      Id<'Account'>,
      readonly { id: Id<'CustomerGroup'>; name: string; archived: boolean }[]
    >
  > {
    const answer = new Map<
      Id<'Account'>,
      { id: Id<'CustomerGroup'>; name: string; archived: boolean }[]
    >();
    for (const id of accountIds) {
      answer.set(
        id,
        this.#ofMarket(market)
          .filter((group) => this.members.get(key(market, group.id))?.has(id))
          .map((group) => ({
            id: group.id,
            name: group.name,
            archived: group.archivedAt !== null,
          })),
      );
    }
    return Promise.resolve(answer);
  }

  isMember(
    market: MarketContext,
    groupId: Id<'CustomerGroup'>,
    accountId: Id<'Account'>,
  ): Promise<{ readonly member: boolean; readonly archived: boolean } | null> {
    const group = this.groups.get(key(market, groupId));
    if (group === undefined) return Promise.resolve(null);
    return Promise.resolve({
      member: this.members.get(key(market, groupId))?.has(accountId) ?? false,
      archived: group.archivedAt !== null,
    });
  }

  /** What the erasure does: drops the account from every group of the Market. */
  forget(market: MarketContext, accountId: Id<'Account'>): void {
    for (const [k, set] of this.members)
      if (k.startsWith(`${market.marketId}:`)) set.delete(accountId);
    this.#syncRows(market);
  }
}

export class InMemoryCustomerNotes implements CustomerNoteRepository {
  readonly notes = new Map<string, StoredCustomerNote[]>();

  insert(market: MarketContext, note: StoredCustomerNote): Promise<void> {
    const k = key(market, note.accountId);
    this.notes.set(k, [...(this.notes.get(k) ?? []), note]);
    return Promise.resolve();
  }

  page(
    market: MarketContext,
    accountId: Id<'Account'>,
    after: { readonly createdAt: Temporal.Instant; readonly id: string } | null,
    limit: number,
  ): Promise<readonly StoredCustomerNote[]> {
    const sorted = [...(this.notes.get(key(market, accountId)) ?? [])].sort((a, b) => {
      const byTime = Temporal.Instant.compare(b.createdAt, a.createdAt);
      return byTime !== 0 ? byTime : b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    });
    const rest =
      after === null
        ? sorted
        : sorted.filter((note) => {
            const byTime = Temporal.Instant.compare(note.createdAt, after.createdAt);
            return byTime < 0 || (byTime === 0 && note.id < after.id);
          });
    return Promise.resolve(rest.slice(0, limit));
  }

  count(market: MarketContext, accountId: Id<'Account'>): Promise<number> {
    return Promise.resolve(this.notes.get(key(market, accountId))?.length ?? 0);
  }
}

/** A reversible stand-in for the subject-key cipher; `destroy` plays an erased account's key. */
export class FakeNoteCipher implements CustomerNoteCipher {
  readonly destroyed = new Set<string>();
  /** Accounts that have a key; null: every account has one. The real service throws for others. */
  keyed: Set<string> | null = null;

  #check(market: MarketContext, accountId: Id<'Account'>): void {
    if (this.keyed !== null && !this.keyed.has(key(market, accountId))) {
      throw new Error('subject key missing');
    }
  }

  destroy(market: MarketContext, accountId: Id<'Account'>): void {
    this.destroyed.add(key(market, accountId));
  }

  seal(
    market: MarketContext,
    accountId: Id<'Account'>,
    body: string,
  ): Promise<Result<string, NoteKeyDestroyed>> {
    this.#check(market, accountId);
    if (this.destroyed.has(key(market, accountId))) {
      return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    }
    return Promise.resolve(
      ok(`v1.${Buffer.from(`${key(market, accountId)}|${body}`).toString('base64url')}`),
    );
  }

  open(
    market: MarketContext,
    accountId: Id<'Account'>,
    sealed: string,
  ): Promise<Result<string, NoteKeyDestroyed>> {
    if (this.destroyed.has(key(market, accountId))) {
      return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    }
    const text = Buffer.from(sealed.slice(3), 'base64url').toString();
    const prefix = `${key(market, accountId)}|`;
    if (!text.startsWith(prefix)) return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    return Promise.resolve(ok(text.slice(prefix.length)));
  }
}

export class InMemoryCustomerTimeline implements CustomerTimelineRepository {
  readonly entries = new Map<string, TimelineEntry[]>();

  constructor(private readonly list: InMemoryCustomerList) {}

  async hasCustomer(market: MarketContext, accountId: Id<'Account'>): Promise<boolean> {
    return (await this.list.rowsByIds(market, [accountId])).length > 0;
  }

  async record(
    market: MarketContext,
    entry: TimelineEntry,
    _at: Temporal.Instant,
    options?: { readonly onceSince?: Temporal.Instant },
  ): Promise<boolean> {
    if (!(await this.hasCustomer(market, entry.accountId))) return false;
    const k = key(market, entry.accountId);
    const all = this.entries.get(k) ?? [];
    const since = options?.onceSince;
    if (
      since !== undefined &&
      all.some(
        (e) =>
          e.kind === entry.kind &&
          e.actorAccountId === entry.actorAccountId &&
          e.detail === entry.detail &&
          Temporal.Instant.compare(e.occurredAt, since) >= 0,
      )
    ) {
      return false;
    }
    if (entry.sourceEventId !== null && all.some((e) => e.sourceEventId === entry.sourceEventId)) {
      return false;
    }
    this.entries.set(k, [...all, entry]);
    return true;
  }

  async recordMany(
    market: MarketContext,
    entries: readonly TimelineEntry[],
    at: Temporal.Instant,
  ): Promise<number> {
    let written = 0;
    for (const entry of entries) if (await this.record(market, entry, at)) written += 1;
    return written;
  }

  #match(market: MarketContext, query: TimelineQuery): TimelineEntry[] {
    return (this.entries.get(key(market, query.accountId)) ?? []).filter(
      (entry) =>
        (query.kinds === null || query.kinds.includes(entry.kind)) &&
        (query.from === null || Temporal.Instant.compare(entry.occurredAt, query.from) >= 0) &&
        (query.to === null || Temporal.Instant.compare(entry.occurredAt, query.to) < 0),
    );
  }

  page(
    market: MarketContext,
    query: TimelineQuery,
    order: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ): Promise<readonly TimelineEntry[]> {
    const sign = order === 'asc' ? 1 : -1;
    const sorted = this.#match(market, query).sort((a, b) => {
      const byTime = Temporal.Instant.compare(a.occurredAt, b.occurredAt);
      return sign * (byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    return Promise.resolve(sorted.slice(window.offset, window.offset + window.limit));
  }

  count(market: MarketContext, query: TimelineQuery): Promise<number> {
    return Promise.resolve(this.#match(market, query).length);
  }
}
