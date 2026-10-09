import { createHash } from 'node:crypto';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type {
  CallContext,
  ContentHash,
  Id,
  MarketContext,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../src/platform/events/outbox-writer';
import type { EventDelivery } from '../../src/platform/events/event-delivery';
import type {
  HandledOnce,
  UnitOfWork,
  UnitOfWorkOptions,
} from '../../src/platform/unit-of-work/unit-of-work';
import type {
  ApprovedZones,
  BusinessFileRevisionRepository,
  RevisionAddRefused,
} from '../../src/modules/sellers/application/ports/business-file-revision.repository';
import type {
  RateCounter,
  RateCounterRepository,
} from '../../src/modules/sellers/application/ports/rate-counter.repository';
import type {
  ReviewerNoticeResult,
  ReviewerNotifier,
} from '../../src/modules/sellers/application/ports/reviewer-notifier';
import type {
  RevisionContentSealer,
  SealedRevision,
} from '../../src/modules/sellers/application/ports/revision-content-sealer';
import type { SellerAccessReader } from '../../src/modules/sellers/application/ports/seller-access-reader';
import type { SellerFileRepository } from '../../src/modules/sellers/application/ports/seller-file.repository';
import type {
  ShopSlugHolder,
  ShopSlugRepository,
  SlugHoldOutcome,
} from '../../src/modules/sellers/application/ports/shop-slug.repository';
import {
  canonicalContent,
  parseContent,
  type BusinessFileContent,
  type BusinessFileRevision,
} from '../../src/modules/sellers/domain/business-file-revision';
import type { RateReservation } from '../../src/modules/sellers/domain/rate-limits';
import type {
  Sealed,
  SealedField,
  SealedRevisionContent,
} from '../../src/modules/sellers/domain/sealed';
import type {
  SealedFieldValues,
  SellerFileCipher,
} from '../../src/modules/sellers/application/ports/seller-file-cipher';
import { SellerFile } from '../../src/modules/sellers/domain/seller-file';
import type { AccessState } from '../../src/modules/sellers/domain/seller-status';
import type { ShopSlug } from '../../src/modules/sellers/domain/shop-slug';

// In-memory stand-ins of the slice 5b ports for suites without a database (sellers design 3.1,
// 7.1a, 7.3, 7.5). What the real stores add (row locks, unique keys, the privilege rules) is
// covered by test/db/sellers-submit.db-spec.ts; these fakes keep the same compare-and-set rules
// and the same keys, and a transactional unit of work that drops every write of a unit that ends
// in `err` or throws, as the real one rolls back.

/** A store that can be copied and put back: what the transactional unit rolls back to. */
export interface Snapshottable {
  snapshot(): () => void;
}

/** `run` rolls back every registered store on `err` and on an exception; `runOnce` has an inbox. */
export class TransactionalUnitOfWork implements UnitOfWork {
  readonly readOnly: boolean[] = [];
  readonly handled = new Set<string>();

  constructor(private readonly stores: readonly Snapshottable[]) {}

  async run<T, E>(
    _market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options?: UnitOfWorkOptions,
  ): Promise<Result<T, E>> {
    this.readOnly.push(options?.readOnly === true);
    const restores = this.stores.map((store) => store.snapshot());
    try {
      const result = await work();
      if (!result.ok) restores.forEach((restore) => restore());
      return result;
    } catch (error) {
      restores.forEach((restore) => restore());
      throw error;
    }
  }

  async runOnce<T, E>(
    market: MarketContext,
    delivery: EventDelivery,
    work: () => Promise<Result<T, E>>,
  ): Promise<Result<HandledOnce<T>, E>> {
    const key = `${market.marketId}|${delivery.eventId}|${delivery.subscriber}`;
    if (this.handled.has(key)) return ok({ handled: false });
    const done = await this.run(market, work);
    if (!done.ok) return done;
    this.handled.add(key);
    return ok({ handled: true, value: done.value });
  }
}

const copyMap = <K, V>(map: Map<K, V>): (() => void) => {
  const copy = new Map(map);
  return () => {
    map.clear();
    for (const [key, value] of copy) map.set(key, value);
  };
};

/** The seller files, with the version compare-and-set of `saveDraft` and `recordChange`. */
export class InMemoryFiles implements SellerFileRepository, Snapshottable {
  readonly stored = new Map<string, SellerFile['state']>();
  /** Runs at the start of a write, before its compare: a concurrent writer gets in here. */
  beforeWrite: (() => void) | null = null;

  key = (market: MarketContext, sellerId: string) => `${market.marketId}|${sellerId}`;

  snapshot() {
    return copyMap(this.stored);
  }

  add(file: SellerFile): void {
    this.stored.set(`${file.state.marketId}|${file.state.sellerId}`, file.state);
  }

  addWithRoots(): Promise<boolean> {
    return Promise.reject(new Error('not used here'));
  }

  draftZones(): Promise<ReadonlyMap<Id<'Seller'>, string>> {
    return Promise.reject(new Error('not used here'));
  }

  existingIds(): Promise<ReadonlySet<Id<'Seller'>>> {
    return Promise.reject(new Error('not used here'));
  }

  findById(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerFile | null> {
    const state = this.stored.get(this.key(market, sellerId));
    return Promise.resolve(state === undefined ? null : SellerFile.restore(state));
  }

  saveDraft(market: MarketContext, file: SellerFile): Promise<boolean> {
    this.beforeWrite?.();
    const key = this.key(market, file.state.sellerId);
    const current = this.stored.get(key);
    if (current === undefined || current.version !== file.persistedVersion) {
      return Promise.resolve(false);
    }
    this.stored.set(key, file.state);
    return Promise.resolve(true);
  }

  recordChange(market: MarketContext, file: SellerFile): Promise<boolean> {
    this.beforeWrite?.();
    const key = this.key(market, file.state.sellerId);
    const current = this.stored.get(key);
    if (current === undefined || current.version !== file.persistedVersion) {
      return Promise.resolve(false);
    }
    this.stored.set(key, {
      ...current,
      version: file.state.version,
      lastChangedAt: file.state.lastChangedAt,
    });
    return Promise.resolve(true);
  }

  /** Marks the file as having an approved revision (slice 7 sets the pointer; here the state). */
  approve(market: MarketContext, sellerId: Id<'Seller'>): void {
    const key = this.key(market, sellerId);
    this.stored.set(key, { ...this.stored.get(key)!, hasApprovedRevision: true });
  }
}

/** Revisions with the keys of data design 3.2: one pending per file, the number, the id. */
export class InMemoryRevisions implements BusinessFileRevisionRepository, Snapshottable {
  readonly rows = new Map<string, { revision: BusinessFileRevision; sealed: SealedRevision }>();
  /** Runs at the start of `saveWithdrawal`, before its status compare: a decision gets in here. */
  beforeWithdrawal: (() => void) | null = null;

  snapshot() {
    return copyMap(this.rows);
  }

  private of(market: MarketContext, sellerId: string) {
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${market.marketId}|${sellerId}|`))
      .map(([, row]) => row.revision);
  }

  add(
    market: MarketContext,
    revision: BusinessFileRevision,
    sealed: SealedRevision,
  ): Promise<Result<void, RevisionAddRefused>> {
    const own = this.of(market, revision.sellerId);
    if (own.some((candidate) => candidate.id === revision.id)) {
      return Promise.resolve(err({ code: 'revision.id-taken' }));
    }
    if (revision.status === 'pending' && own.some((candidate) => candidate.status === 'pending')) {
      return Promise.resolve(err({ code: 'revision.pending-exists' }));
    }
    if (own.some((candidate) => candidate.revisionNo === revision.revisionNo)) {
      return Promise.resolve(err({ code: 'revision.number-taken' }));
    }
    this.rows.set(`${market.marketId}|${revision.sellerId}|${revision.id}`, { revision, sealed });
    return Promise.resolve(ok(undefined));
  }

  findLatest(market: MarketContext, sellerId: Id<'Seller'>) {
    const own = this.of(market, sellerId).sort((a, b) => b.revisionNo - a.revisionNo);
    return Promise.resolve(own[0] ?? null);
  }

  findPending(market: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(
      this.of(market, sellerId).find((candidate) => candidate.status === 'pending') ?? null,
    );
  }

  findApproved(market: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(
      this.of(market, sellerId).find((candidate) => candidate.status === 'approved') ?? null,
    );
  }

  findById(market: MarketContext, sellerId: Id<'Seller'>, id: Id<'BusinessFileRevision'>) {
    return Promise.resolve(this.rows.get(`${market.marketId}|${sellerId}|${id}`)?.revision ?? null);
  }

  saveWithdrawal(market: MarketContext, revision: BusinessFileRevision): Promise<boolean> {
    this.beforeWithdrawal?.();
    const key = `${market.marketId}|${revision.sellerId}|${revision.id}`;
    const row = this.rows.get(key);
    if (row === undefined || row.revision.status !== 'pending' || revision.status !== 'withdrawn') {
      return Promise.resolve(false);
    }
    this.rows.set(key, { ...row, revision });
    return Promise.resolve(true);
  }

  approvedZones(market: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    const found = new Map<Id<'Seller'>, ApprovedZones>();
    for (const sellerId of sellerIds) {
      const approved = this.of(market, sellerId).find(
        (candidate) => candidate.status === 'approved',
      );
      if (approved !== undefined) {
        found.set(sellerId, {
          operatingTimezone: approved.operatingTimezone,
          addressTimezone: approved.addressTimezone,
        });
      }
    }
    return Promise.resolve(found);
  }

  readSealedContent(market: MarketContext, sellerId: Id<'Seller'>, id: Id<'BusinessFileRevision'>) {
    return Promise.resolve(
      this.rows.get(`${market.marketId}|${sellerId}|${id}`)?.sealed.ciphertext ?? null,
    );
  }

  /** Puts a revision straight in the store as a decision would (tests of other states). */
  force(market: MarketContext, revision: BusinessFileRevision): void {
    const row = this.rows.get(`${market.marketId}|${revision.sellerId}|${revision.id}`)!;
    this.rows.set(`${market.marketId}|${revision.sellerId}|${revision.id}`, { ...row, revision });
  }
}

/** The outbox, with the unique key `(Market, aggregate, version)` that the real table has. */
export class RecordingOutbox implements OutboxWriter, Snapshottable {
  readonly events: PendingEvent[] = [];

  snapshot() {
    const length = this.events.length;
    return () => {
      this.events.length = length;
    };
  }

  append(context: CallContext, appended: readonly PendingEvent[]): Promise<void> {
    for (const event of appended) {
      const clash = this.events.some(
        (kept) =>
          kept.aggregateId === event.aggregateId &&
          kept.aggregateVersion === event.aggregateVersion,
      );
      if (clash) {
        return Promise.reject(
          new Error(`outbox unique key (${context.market.marketId}, aggregate, version) taken`),
        );
      }
    }
    this.events.push(...appended);
    return Promise.resolve();
  }
}

/** Shop slugs with the unique key `(Market, slug)` and the one-held-slug rule I-S1. */
export class InMemorySlugs implements ShopSlugRepository, Snapshottable {
  readonly rows = new Map<
    string,
    { sellerId: Id<'Seller'>; state: 'held' | 'retired'; everPublic: boolean }
  >();

  snapshot() {
    return copyMap(this.rows);
  }

  findBySlug(market: MarketContext, slug: ShopSlug): Promise<ShopSlugHolder | null> {
    const row = this.rows.get(`${market.marketId}|${slug}`);
    return Promise.resolve(row === undefined ? null : { sellerId: row.sellerId, state: row.state });
  }

  hold(
    market: MarketContext,
    input: { readonly sellerId: Id<'Seller'>; readonly slug: ShopSlug },
  ): Promise<SlugHoldOutcome> {
    const key = `${market.marketId}|${input.slug}`;
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      return Promise.resolve(
        existing.sellerId === input.sellerId && existing.state === 'held'
          ? 'already-held'
          : 'taken',
      );
    }
    const other = [...this.rows.entries()].find(
      ([k, row]) => k.startsWith(`${market.marketId}|`) && row.sellerId === input.sellerId,
    );
    if (other !== undefined) throw new Error('I-S1: the seller holds another slug');
    this.rows.set(key, { sellerId: input.sellerId, state: 'held', everPublic: false });
    return Promise.resolve('held');
  }

  releaseUnpublished(market: MarketContext, sellerId: Id<'Seller'>): Promise<number> {
    let released = 0;
    for (const [key, row] of [...this.rows]) {
      if (
        key.startsWith(`${market.marketId}|`) &&
        row.sellerId === sellerId &&
        row.state === 'held' &&
        !row.everPublic
      ) {
        this.rows.delete(key);
        released += 1;
      }
    }
    return Promise.resolve(released);
  }
}

/** Counters with the fixed window and the guarded release of the two reviewer-notice kinds. */
export class InMemoryCounters implements RateCounterRepository, Snapshottable {
  readonly rows = new Map<string, { count: number; windowStartedAt: Temporal.Instant }>();
  failing = false;
  /** Fails a reserve of this kind only (a store that fails on the second counter). */
  failingKind: string | null = null;

  snapshot() {
    return copyMap(this.rows);
  }

  private keyOf(market: MarketContext, counter: RateCounter) {
    return `${market.marketId}|${counter.limit.kind}|${Buffer.from(counter.keyHash).toString('hex')}`;
  }

  /** The count of the counter of one kind, summed over subjects (a test reads one subject). */
  countOf(kind: string): number {
    return [...this.rows.entries()]
      .filter(([key]) => key.split('|')[1] === kind)
      .reduce((sum, [, row]) => sum + row.count, 0);
  }

  reserve(
    market: MarketContext,
    counters: readonly RateCounter[],
    now: Temporal.Instant,
  ): Promise<readonly RateReservation[]> {
    if (this.failing) return Promise.reject(new Error('counter store down'));
    if (counters.some(({ limit }) => limit.kind === this.failingKind)) {
      return Promise.reject(new Error('counter store down'));
    }
    return Promise.resolve(
      counters.map((counter) => {
        const { limit } = counter;
        const key = this.keyOf(market, counter);
        let row = this.rows.get(key);
        const ended =
          row !== undefined &&
          Temporal.Instant.compare(
            row.windowStartedAt.add({ minutes: limit.windowMinutes }),
            now,
          ) <= 0;
        if (row === undefined || ended) row = { count: 0, windowStartedAt: now };
        row = { ...row, count: row.count + 1 };
        this.rows.set(key, row);
        return { kind: limit.kind, count: row.count, windowStartedAt: row.windowStartedAt };
      }),
    );
  }

  release(
    market: MarketContext,
    counter: RateCounter,
    windowStartedAt: Temporal.Instant,
  ): Promise<boolean> {
    const key = this.keyOf(market, counter);
    const row = this.rows.get(key);
    if (row === undefined || row.count < 1 || !row.windowStartedAt.equals(windowStartedAt)) {
      return Promise.resolve(false);
    }
    this.rows.set(key, { ...row, count: row.count - 1 });
    return Promise.resolve(true);
  }

  purgeStartedBefore(): Promise<number> {
    return Promise.reject(new Error('not used here'));
  }
}

/** The access state `identity` reports; an unknown seller answers null. */
export class FakeAccess implements SellerAccessReader {
  readonly states = new Map<string, AccessState>();
  failing = false;

  set(sellerId: Id<'Seller'>, state: AccessState): void {
    this.states.set(sellerId, state);
  }

  accessOf(_context: CallContext, sellerId: Id<'Seller'>): Promise<AccessState | null> {
    if (this.failing) return Promise.reject(new Error('identity down'));
    return Promise.resolve(this.states.get(sellerId) ?? null);
  }

  /** Every call of the batch read, to prove a page makes one. */
  readonly manyCalls: (readonly Id<'Seller'>[])[] = [];

  accessOfMany(
    _context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, AccessState>> {
    this.manyCalls.push(sellerIds);
    if (this.failing) return Promise.reject(new Error('identity down'));
    return Promise.resolve(
      new Map(
        sellerIds.flatMap((id): [Id<'Seller'>, AccessState][] => {
          const state = this.states.get(id);
          return state === undefined ? [] : [[id, state]];
        }),
      ),
    );
  }
}

/** The reviewer notice: programmable answers, every call counted. */
export class FakeNotifier implements ReviewerNotifier {
  answers: (ReviewerNoticeResult | 'throw')[] = [];
  readonly calls: Id<'Seller'>[] = [];

  notify(_context: CallContext, sellerId: Id<'Seller'>): Promise<ReviewerNoticeResult> {
    this.calls.push(sellerId);
    const answer = this.answers.shift() ?? 'sent';
    if (answer === 'throw') return Promise.reject(new Error('identity refused'));
    return Promise.resolve(answer);
  }
}

/** Seals as readable base64 of the canonical JSON; the hash is a SHA-256 over the same bytes. */
export class FakeSealer implements RevisionContentSealer {
  failing = false;
  sealed = 0;

  private hashOf(json: string): ContentHash {
    return `hmac-sha256:${createHash('sha256').update(json).digest('hex')}` as ContentHash;
  }

  seal(_market: MarketContext, _sellerId: Id<'Seller'>, content: BusinessFileContent) {
    if (this.failing) return Promise.reject(new Error('key store down'));
    const json = canonicalContent(content);
    if (!json.ok) return Promise.resolve(err(json.error));
    this.sealed += 1;
    return Promise.resolve(
      ok({
        ciphertext:
          `sealed.${Buffer.from(json.value).toString('base64url')}` as SealedRevisionContent,
        contentHash: this.hashOf(json.value),
      }),
    );
  }

  open(_market: MarketContext, _sellerId: Id<'Seller'>, sealed: SealedRevisionContent) {
    return Promise.resolve(
      parseContent(Buffer.from(sealed.slice('sealed.'.length), 'base64url').toString()),
    );
  }

  hash(_market: MarketContext, _sellerId: Id<'Seller'>, content: BusinessFileContent) {
    const json = canonicalContent(content);
    return Promise.resolve(json.ok ? ok(this.hashOf(json.value)) : err(json.error));
  }
}

/** Seals as a readable tag bound to Market, seller and field: a copy elsewhere does not open. */
export class ReadableCipher implements SellerFileCipher {
  destroyed = new Set<string>();

  seal<F extends SealedField>(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: F,
    value: SealedFieldValues[F],
  ): Promise<Result<Sealed<F>, { code: 'subject-key.destroyed' }>> {
    if (this.destroyed.has(sellerId)) {
      return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    }
    const plain =
      typeof value === 'string' ? value : JSON.stringify((value as { fields: object }).fields);
    const body = Buffer.from(plain).toString('base64url');
    return Promise.resolve(ok(`v1.${market.marketId}.${sellerId}.${field}.${body}` as Sealed<F>));
  }

  open<F extends SealedField>(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: F,
    sealed: Sealed<F>,
  ): Promise<Result<string, { code: 'subject-key.destroyed' }>> {
    if (this.destroyed.has(sellerId)) {
      return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    }
    const prefix = `v1.${market.marketId}.${sellerId}.${field}.`;
    if (!sealed.startsWith(prefix)) return Promise.reject(new Error('integrity'));
    return Promise.resolve(ok(Buffer.from(sealed.slice(prefix.length), 'base64url').toString()));
  }
}
