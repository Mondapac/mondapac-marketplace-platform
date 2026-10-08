import { Temporal } from '@mondapac/shared-kernel';
import type { ContentHash, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  compareKeys,
  keyOf,
  SealInsertConflictError,
  type AuditChainStore,
  type CheckpointRecord,
  type SealKey,
  type SealRecord,
  type SealWithRow,
  type Watermark,
} from '../../src/platform/audit/audit-chain-store';
import type { AuditRowRecord } from '../../src/platform/audit/audit-hash';
import type {
  AnchorSink,
  AnchorSource,
  ChainAnchor,
  StoredAnchor,
} from '../../src/platform/audit/anchor-sink';
import type { UnitOfWork, UnitOfWorkOptions } from '../../src/platform/unit-of-work/unit-of-work';

// In-memory doubles of the audit chain's ports, for the unit tests of the sealer and the
// verifier (docs/design/domain/platform-audit.md 16, "Unit"). They keep the keys of the seal
// table (docs/design/data/platform.md 11.3): the primary key (market, epoch, chain_seq), the
// unique key (market, epoch, occurred_at, id) and the foreign key to the row with its time. The
// database behaviour itself is covered by test/db/platform-audit-chain.db-spec.ts.

const inWindow = (row: AuditRowRecord, from: Temporal.Instant, upTo: SealKey) =>
  Temporal.Instant.compare(row.occurredAt, from) >= 0 && compareKeys(keyOf(row), upTo) <= 0;

const byKey = (a: AuditRowRecord, b: AuditRowRecord) => compareKeys(keyOf(a), keyOf(b));

/** The chain tables of every Market, in memory. Tests may edit them to tamper. */
export class InMemoryAuditChainStore implements AuditChainStore {
  readonly rows: AuditRowRecord[] = [];
  seals: SealRecord[] = [];
  checkpoints: CheckpointRecord[] = [];
  /** Runs before each insert of seals: a concurrent sealer, in a test. */
  beforeInsert: ((market: MarketContext, seals: readonly SealRecord[]) => void) | null = null;
  /** Runs after each read of a range of seals: a chain that grows during a verification. */
  afterSealsBetween: (() => void) | null = null;
  /** Makes the next insert of seals fail with this error, once. */
  failNextInsert: Error | null = null;

  /** The Market of every row ever added, so a seal keeps its Market when a test deletes its row. */
  private readonly marketOfRow = new Map<string, string>();

  addRow(row: AuditRowRecord): void {
    this.rows.push(row);
    this.marketOfRow.set(row.id, row.marketId);
  }

  private sealsOf(market: MarketContext, epoch?: number): SealRecord[] {
    const ids = new Set(
      [...this.marketOfRow]
        .filter(([, marketId]) => marketId === market.marketId)
        .map(([id]) => id),
    );
    return this.seals.filter(
      (seal) => ids.has(seal.auditLogId) && (epoch === undefined || seal.epoch === epoch),
    );
  }

  private rowsOf(market: MarketContext): AuditRowRecord[] {
    return this.rows.filter((row) => row.marketId === market.marketId).sort(byKey);
  }

  lastSeals(market: MarketContext, epoch: number, count: number): Promise<SealRecord[]> {
    const seals = this.sealsOf(market, epoch).sort((a, b) =>
      a.chainSeq < b.chainSeq ? 1 : a.chainSeq > b.chainSeq ? -1 : 0,
    );
    return Promise.resolve(seals.slice(0, count));
  }

  watermark(market: MarketContext, epoch: number): Promise<Watermark | null> {
    let best: SealRecord | null = null;
    for (const seal of this.sealsOf(market, epoch)) {
      const key = { occurredAt: seal.auditOccurredAt, auditLogId: seal.auditLogId };
      if (
        best === null ||
        compareKeys(key, { occurredAt: best.auditOccurredAt, auditLogId: best.auditLogId }) > 0
      ) {
        best = seal;
      }
    }
    return Promise.resolve(
      best === null
        ? null
        : {
            occurredAt: best.auditOccurredAt,
            auditLogId: best.auditLogId,
            chainSeq: best.chainSeq,
          },
    );
  }

  rowsAbove(
    market: MarketContext,
    after: SealKey | null,
    settledUntil: Temporal.Instant,
    limit: number,
  ): Promise<AuditRowRecord[]> {
    return Promise.resolve(
      this.rowsOf(market)
        .filter(
          (row) =>
            Temporal.Instant.compare(row.occurredAt, settledUntil) <= 0 &&
            (after === null || compareKeys(keyOf(row), after) > 0),
        )
        .slice(0, limit),
    );
  }

  unsealedRows(
    market: MarketContext,
    epoch: number,
    from: Temporal.Instant,
    upTo: SealKey,
    limit: number,
    after?: SealKey,
  ): Promise<AuditRowRecord[]> {
    const sealed = new Set(this.sealsOf(market, epoch).map((seal) => seal.auditLogId));
    return Promise.resolve(
      this.rowsOf(market)
        .filter(
          (row) =>
            inWindow(row, from, upTo) &&
            !sealed.has(row.id) &&
            (after === undefined || compareKeys(keyOf(row), after) > 0),
        )
        .slice(0, limit),
    );
  }

  insertSeals(market: MarketContext, seals: readonly SealRecord[]): Promise<void> {
    this.beforeInsert?.(market, seals);
    if (this.failNextInsert !== null) {
      const error = this.failNextInsert;
      this.failNextInsert = null;
      return Promise.reject(error);
    }
    const existing = this.sealsOf(market);
    for (const seal of seals) {
      const row = this.rows.find((r) => r.id === seal.auditLogId && r.marketId === market.marketId);
      if (
        row === undefined ||
        row.occurredAt.epochNanoseconds !== seal.auditOccurredAt.epochNanoseconds
      ) {
        return Promise.reject(new Error('foreign key: no such row'));
      }
      const all = [...existing, ...seals.slice(0, seals.indexOf(seal))];
      if (all.some((s) => s.epoch === seal.epoch && s.chainSeq === seal.chainSeq)) {
        return Promise.reject(new SealInsertConflictError('position-taken'));
      }
      if (all.some((s) => s.epoch === seal.epoch && s.auditLogId === seal.auditLogId)) {
        return Promise.reject(new SealInsertConflictError('row-sealed'));
      }
    }
    this.seals.push(...seals);
    return Promise.resolve();
  }

  sealsOfRows(market: MarketContext, epoch: number, ids: readonly string[]): Promise<SealRecord[]> {
    return Promise.resolve(this.sealsOf(market, epoch).filter((s) => ids.includes(s.auditLogId)));
  }

  private checkpointsOf(market: MarketContext, epoch: number): CheckpointRecord[] {
    return this.checkpoints
      .filter((c) => (c as CheckpointRecord & { marketId?: string }).marketId === market.marketId)
      .filter((c) => c.epoch === epoch)
      .sort((a, b) => (a.chainSeq < b.chainSeq ? -1 : a.chainSeq > b.chainSeq ? 1 : 0));
  }

  latestCheckpoint(
    market: MarketContext,
    epoch: number,
    atOrBelow?: bigint,
  ): Promise<CheckpointRecord | null> {
    const fitting = this.checkpointsOf(market, epoch).filter(
      (c) => atOrBelow === undefined || c.chainSeq <= atOrBelow,
    );
    return Promise.resolve(fitting.at(-1) ?? null);
  }

  insertCheckpoint(market: MarketContext, checkpoint: CheckpointRecord): Promise<void> {
    this.checkpoints.push({ ...checkpoint, marketId: market.marketId } as CheckpointRecord);
    return Promise.resolve();
  }

  sealsBetween(
    market: MarketContext,
    epoch: number,
    fromSeq: bigint,
    toSeq: bigint,
    limit: number,
  ): Promise<SealWithRow[]> {
    const found = this.sealsOf(market, epoch)
      .filter((s) => s.chainSeq >= fromSeq && s.chainSeq <= toSeq)
      .sort((a, b) => (a.chainSeq < b.chainSeq ? -1 : a.chainSeq > b.chainSeq ? 1 : 0))
      .slice(0, limit)
      .map((seal) => ({
        seal,
        row: this.rows.find((r) => r.id === seal.auditLogId) ?? null,
      }));
    this.afterSealsBetween?.();
    return Promise.resolve(found);
  }

  checkpointsBetween(
    market: MarketContext,
    epoch: number,
    fromSeq: bigint,
    toSeq: bigint,
  ): Promise<CheckpointRecord[]> {
    return Promise.resolve(
      this.checkpointsOf(market, epoch).filter((c) => c.chainSeq >= fromSeq && c.chainSeq <= toSeq),
    );
  }

  sealsOutsideEpochs(
    market: MarketContext,
    known: readonly number[],
    limit: number,
  ): Promise<SealRecord[]> {
    return Promise.resolve(
      this.sealsOf(market)
        .filter((s) => !known.includes(s.epoch))
        .slice(0, limit),
    );
  }

  rowsAfter(
    market: MarketContext,
    after: Temporal.Instant,
    limit: number,
  ): Promise<AuditRowRecord[]> {
    return Promise.resolve(
      this.rowsOf(market)
        .filter((row) => Temporal.Instant.compare(row.occurredAt, after) > 0)
        .slice(0, limit),
    );
  }

  earliestRowTime(market: MarketContext): Promise<Temporal.Instant | null> {
    return Promise.resolve(this.rowsOf(market)[0]?.occurredAt ?? null);
  }

  /** Replaces one stored seal (tampering, in a test). */
  replaceSeal(
    epoch: number,
    chainSeq: bigint,
    change: Partial<SealRecord>,
    marketId: string,
  ): void {
    const ids = new Set(
      [...this.marketOfRow].filter(([, owner]) => owner === marketId).map(([id]) => id),
    );
    this.seals = this.seals.map((seal) =>
      ids.has(seal.auditLogId) && seal.epoch === epoch && seal.chainSeq === chainSeq
        ? { ...seal, ...change }
        : seal,
    );
  }
}

/**
 * A UnitOfWork with no database: `run` calls `work` once, read-only or not. Counts the units it
 * ran by kind, so a test can check that the verifier reads in read-only units only (ADR-0025).
 */
export class FakeUnitOfWork implements UnitOfWork {
  readonly units: ('read-only' | 'read-write')[] = [];

  async run<T, E>(
    _market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options: UnitOfWorkOptions = {},
  ): Promise<Result<T, E>> {
    this.units.push(options.readOnly === true ? 'read-only' : 'read-write');
    return work();
  }

  runOnce(): never {
    throw new Error('FakeUnitOfWork: runOnce is not used by the audit chain');
  }
}

/** An anchor that records what it is sent and can be read back, version by version. */
export class RecordingAnchor implements AnchorSink, AnchorSource {
  readonly checkpoints: ChainAnchor[] = [];
  readonly heartbeats: ChainAnchor[] = [];
  /** Extra versions stored under a key, as an overwrite would leave them (tests). */
  readonly extraVersions = new Map<string, ContentHash[]>();
  down = false;

  checkpoint(anchor: ChainAnchor): Promise<void> {
    if (this.down) return Promise.reject(new Error('anchor unreachable'));
    this.checkpoints.push(anchor);
    return Promise.resolve();
  }

  heartbeat(anchor: ChainAnchor): Promise<void> {
    if (this.down) return Promise.reject(new Error('anchor unreachable'));
    this.heartbeats.push(anchor);
    return Promise.resolve();
  }

  anchors(marketId: string, epoch: number): Promise<readonly StoredAnchor[]> {
    return Promise.resolve(
      this.checkpoints
        .filter((a) => a.marketId === marketId && a.epoch === epoch)
        .map((a) => ({
          chainSeq: a.chainSeq,
          versions: [
            a.chainHash,
            ...(this.extraVersions.get(`${marketId}/${epoch}/${a.chainSeq}`) ?? []),
          ],
        })),
    );
  }
}
