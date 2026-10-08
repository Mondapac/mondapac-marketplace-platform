import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, MarketContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';
import { logAuditAlert, type AuditAlertCode } from './audit-alerts';
import {
  CURRENT_EPOCH,
  KNOWN_EPOCHS,
  MAX_FINDINGS_PER_CODE,
  SETTLE_WINDOW,
  UNSEALED_SLICE,
  VERIFY_BATCH_SIZE,
} from './audit-chain-policy';
import {
  compareKeys,
  keyOf,
  type AuditChainStore,
  type CheckpointRecord,
  type SealKey,
  type SealRecord,
  type Watermark,
} from './audit-chain-store';
import {
  chainHashOf,
  chainHashText,
  genesisPrev,
  hashAuditRow,
  KNOWN_HASH_VERSIONS,
  sameHash,
} from './audit-hash';
import type { AnchorSource, StoredAnchor } from './anchor-sink';

/** `full` from the start of the chain; `incremental` from the last checkpoint (PA 8). */
export type VerifyMode = 'full' | 'incremental';

/** One finding: a fixed code and a position, never row content (PA 8). */
export interface AuditFinding {
  readonly code: AuditAlertCode;
  readonly marketId: string;
  readonly epoch: number | null;
  readonly chainSeq: bigint | null;
  readonly auditLogId: string | null;
}

/** What one verification of one Market found. */
export interface VerifyReport {
  readonly marketId: string;
  readonly mode: VerifyMode;
  /** The head read once at the start; nothing past it was verified (Hassan L1). */
  readonly pinnedHead: bigint | null;
  /** The first `chain_seq` the walk verified (1 for a full run). */
  readonly fromSeq: bigint | null;
  readonly sealsChecked: number;
  readonly findings: readonly AuditFinding[];
}

/** The state of the walk along one epoch's chain. */
interface Walk {
  /** The chain hash the next link must build on; null after a gap until re-synchronised. */
  prev: Uint8Array | null;
  expectedSeq: bigint;
  hashVersion: number;
  lastNonLate: SealKey | null;
}

/**
 * The verifier of docs/design/domain/platform-audit.md 8 (`platform.audit-verify`, and the
 * operator command `audit-verify`). It reads only, as the system actor, in read-only units
 * (ADR-0025) and in batches; it is logged, not audited. It never trusts a stored hash: every
 * `row_hash` and `chain_hash` is recomputed from the rows read back.
 *
 * - **Pinned head** (Hassan L1): the anchors are read first, then the head of the current
 *   epoch, once; the walk stops at that head however the chain grows meanwhile.
 * - (a) `chain_seq` runs 1..head with no gap (`audit.chain.gap`); a seal in an epoch the
 *   verifier does not know is `audit.seal.unknown-epoch` (F12).
 * - (b) every link recomputes from its predecessor (`audit.chain.broken`). After a finding the
 *   walk re-synchronises on the stored chain hash, so a break is reported where it is and the
 *   later links are still checked (a changed `chain_hash` breaks its own link and the next).
 * - (c) every `row_hash` matches its row as read (`audit.row.mismatch`); the fallback form is
 *   chosen only by whether `canonicalJson` refuses the row (Hassan N1 c), so a row that
 *   canonicalises but carries a fallback-style hash is a mismatch.
 * - (d) every row at or below the watermark has a seal in the epoch (`audit.row.unsealed`), in
 *   one-day slices; the foreign key gives every seal its row (`audit.row.missing` otherwise).
 * - (e) every checkpoint matches the chain at its `chain_seq` (`audit.checkpoint.mismatch`).
 * - (f) with an `AnchorSource`: the head is at or past every anchor, the chain hash at each
 *   anchor equals it, and every version of an anchor key is identical (`audit.anchor.mismatch`).
 * - (g) `audit_occurred_at` equals the row's `occurred_at` (`audit.seal.time-mismatch`).
 * - (h) non-late seals strictly ascend in `(occurred_at, id)` (`audit.seal.out-of-order`).
 * - (i) `hash_version` is known and never goes down (`audit.seal.hash-version`).
 * - (j) no row is later than `now + S` (`audit.row.future`).
 * - (k) numbers in `before` and `after` are safe integers (`audit.row.noncanonical`, also for
 *   every row hashed with the fallback).
 *
 * Each finding is one error-level line marked for alerting; it changes nothing.
 */
export class AuditVerifier {
  private readonly logger = new Logger('AuditVerifier');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: AuditChainStore,
    private readonly clock: Clock,
    private readonly anchorSource: AnchorSource | null = null,
  ) {}

  async verify(context: CallContext, mode: VerifyMode): Promise<VerifyReport> {
    const market = context.market;
    const marketId = market.marketId;
    const epoch = CURRENT_EPOCH;
    const findings: AuditFinding[] = [];
    const counts = new Map<AuditAlertCode, number>();
    const find = (
      code: AuditAlertCode,
      chainSeq: bigint | null,
      auditLogId: string | null,
      findingEpoch: number | null = epoch,
    ): void => {
      const count = (counts.get(code) ?? 0) + 1;
      counts.set(code, count);
      if (count > MAX_FINDINGS_PER_CODE) return;
      const finding = { code, marketId, epoch: findingEpoch, chainSeq, auditLogId };
      findings.push(finding);
      logAuditAlert(this.logger, code, finding);
    };

    // The anchors first, then the head: an anchor is written only after its seal committed,
    // so every anchor read before the head is at or below it unless the tail was cut.
    const anchors =
      this.anchorSource === null ? null : await this.anchorSource.anchors(marketId, epoch);
    const now = this.clock.now();
    const pinned = await this.read(market, async () => {
      const [head] = await this.store.lastSeals(market, epoch, 1);
      return head ?? null;
    });
    const watermark = await this.read(market, () => this.store.watermark(market, epoch));

    // (a) Seals of an epoch nobody opened.
    const foreign = await this.read(market, () =>
      this.store.sealsOutsideEpochs(market, KNOWN_EPOCHS, MAX_FINDINGS_PER_CODE),
    );
    for (const seal of foreign) {
      find('audit.seal.unknown-epoch', seal.chainSeq, seal.auditLogId, seal.epoch);
    }

    // The starting point of the walk.
    const walk: Walk = {
      prev: genesisPrev(),
      expectedSeq: 1n,
      hashVersion: 0,
      lastNonLate: null,
    };
    let fromSeq: bigint | null = pinned === null ? null : 1n;
    let start: SealRecord | null = null;
    if (mode === 'incremental' && pinned !== null) {
      const checkpoint = await this.read(market, () =>
        this.store.latestCheckpoint(market, epoch, pinned.chainSeq),
      );
      if (checkpoint !== null) {
        const [seal] = await this.read(market, () =>
          this.store.sealsBetween(market, epoch, checkpoint.chainSeq, checkpoint.chainSeq, 1),
        );
        if (seal === undefined) {
          find('audit.chain.gap', checkpoint.chainSeq, null);
        } else if (
          !sameHash(seal.seal.chainHash, checkpoint.chainHash) ||
          seal.seal.hashVersion !== checkpoint.hashVersion
        ) {
          find('audit.checkpoint.mismatch', checkpoint.chainSeq, seal.seal.auditLogId);
        } else {
          start = seal.seal;
        }
        if (start !== null) {
          walk.prev = checkpoint.chainHash;
          walk.expectedSeq = checkpoint.chainSeq + 1n;
          walk.hashVersion = start.hashVersion;
          walk.lastNonLate = start.late
            ? null
            : { occurredAt: start.auditOccurredAt, auditLogId: start.auditLogId };
          fromSeq = walk.expectedSeq;
        }
      }
    }

    // (b), (c), (e), (f) at each seal, (g), (h), (i), (k), up to the pinned head.
    const anchorsBySeq = new Map<bigint, StoredAnchor>();
    if (anchors !== null) {
      for (const anchor of anchors) {
        anchorsBySeq.set(anchor.chainSeq, anchor);
        if (new Set(anchor.versions).size > 1) find('audit.anchor.mismatch', anchor.chainSeq, null);
        // A cut tail, or a chain recomputed below an anchor: the head is below the anchor.
        if (pinned === null || anchor.chainSeq > pinned.chainSeq) {
          find('audit.anchor.mismatch', anchor.chainSeq, null);
        }
      }
    }
    let sealsChecked = 0;
    if (pinned !== null && walk.expectedSeq <= pinned.chainSeq) {
      const checkpoints = new Map<bigint, CheckpointRecord>();
      for (const checkpoint of await this.read(market, () =>
        this.store.checkpointsBetween(market, epoch, walk.expectedSeq, pinned.chainSeq),
      )) {
        checkpoints.set(checkpoint.chainSeq, checkpoint);
      }
      let next = walk.expectedSeq;
      while (next <= pinned.chainSeq) {
        const to =
          next + BigInt(VERIFY_BATCH_SIZE) - 1n < pinned.chainSeq
            ? next + BigInt(VERIFY_BATCH_SIZE) - 1n
            : pinned.chainSeq;
        const batch = await this.read(market, () =>
          this.store.sealsBetween(market, epoch, next, to, VERIFY_BATCH_SIZE),
        );
        for (const { seal, row } of batch) {
          if (seal.chainSeq > walk.expectedSeq) {
            find('audit.chain.gap', walk.expectedSeq, null);
            walk.prev = null;
          }
          walk.expectedSeq = seal.chainSeq + 1n;
          sealsChecked += 1;

          // (i) a known version, never going down.
          if (
            !KNOWN_HASH_VERSIONS.includes(seal.hashVersion) ||
            seal.hashVersion < walk.hashVersion
          ) {
            find('audit.seal.hash-version', seal.chainSeq, seal.auditLogId);
          }
          walk.hashVersion = Math.max(walk.hashVersion, seal.hashVersion);

          // (c), (g), (k): the row as read back.
          let rowHash = seal.rowHash;
          let rowMismatch = false;
          if (row === null) {
            find('audit.row.missing', seal.chainSeq, seal.auditLogId);
          } else {
            if (row.occurredAt.epochNanoseconds !== seal.auditOccurredAt.epochNanoseconds) {
              find('audit.seal.time-mismatch', seal.chainSeq, seal.auditLogId);
            }
            const recomputed = hashAuditRow(row);
            rowHash = recomputed.hash;
            if (!sameHash(recomputed.hash, seal.rowHash)) {
              rowMismatch = true;
              find('audit.row.mismatch', seal.chainSeq, seal.auditLogId);
            }
            if (!recomputed.canonical) {
              find('audit.row.noncanonical', seal.chainSeq, seal.auditLogId);
            }
          }

          // (b) the link, from the predecessor's chain hash and the recomputed row hash.
          let expected: Uint8Array | null = null;
          if (walk.prev !== null) {
            expected = this.link(seal, walk.prev, rowHash);
            if (expected === null || !sameHash(expected, seal.chainHash)) {
              // A row already reported as edited is not reported twice when its stored row
              // hash still links: the stored chain is intact, the row is not.
              const storedLinks =
                rowMismatch &&
                (() => {
                  const viaStored = this.link(seal, walk.prev, seal.rowHash);
                  return viaStored !== null && sameHash(viaStored, seal.chainHash);
                })();
              if (!storedLinks) find('audit.chain.broken', seal.chainSeq, seal.auditLogId);
            }
          }
          if (seal.chainSeq === 1n && seal.late) {
            find('audit.chain.broken', seal.chainSeq, seal.auditLogId);
          }
          // Re-synchronise on the stored hash, so one break is one finding.
          walk.prev = seal.chainHash;

          // (h) non-late seals strictly ascend in (occurred_at, id).
          if (!seal.late) {
            const key = { occurredAt: seal.auditOccurredAt, auditLogId: seal.auditLogId };
            if (walk.lastNonLate !== null && compareKeys(key, walk.lastNonLate) <= 0) {
              find('audit.seal.out-of-order', seal.chainSeq, seal.auditLogId);
            }
            walk.lastNonLate = key;
          }

          // (e) and (f): what the chain says at this position, recomputed when it links.
          const atSeq = expected !== null && sameHash(expected, seal.chainHash) ? expected : null;
          const checkpoint = checkpoints.get(seal.chainSeq);
          if (
            checkpoint !== undefined &&
            (atSeq === null ||
              !sameHash(checkpoint.chainHash, atSeq) ||
              checkpoint.hashVersion !== seal.hashVersion)
          ) {
            find('audit.checkpoint.mismatch', seal.chainSeq, seal.auditLogId);
          }
          checkpoints.delete(seal.chainSeq);
          const anchor = anchorsBySeq.get(seal.chainSeq);
          // Differing versions of one key were reported above; here the first is compared.
          if (
            anchor !== undefined &&
            (atSeq === null || anchor.versions[0] !== chainHashText(atSeq))
          ) {
            find('audit.anchor.mismatch', seal.chainSeq, seal.auditLogId);
          }
          anchorsBySeq.delete(seal.chainSeq);
        }
        if (batch.length === 0 || walk.expectedSeq <= to) {
          // The range ended early: the seals up to `to` are missing.
          if (walk.expectedSeq <= to) {
            find('audit.chain.gap', walk.expectedSeq, null);
            walk.prev = null;
            walk.expectedSeq = to + 1n;
          }
        }
        next = to + 1n;
      }
      // Checkpoints and anchors at positions with no seal (a gap) do not match the chain.
      for (const checkpoint of checkpoints.values()) {
        find('audit.checkpoint.mismatch', checkpoint.chainSeq, null);
      }
    }
    for (const anchor of anchorsBySeq.values()) {
      const below = fromSeq === null || anchor.chainSeq < fromSeq;
      const beyond = pinned === null || anchor.chainSeq > pinned.chainSeq;
      // Below the walk (an incremental run) is the full run's to check; beyond was reported.
      if (!below && !beyond) find('audit.anchor.mismatch', anchor.chainSeq, null);
    }

    // (d) every row at or below the watermark has a seal in this epoch, a day at a time.
    if (watermark !== null) {
      await this.unsealed(market, mode, start, watermark, find);
    }

    // (j) no row later than now + S: (d) would never judge it.
    const future = await this.read(market, () =>
      this.store.rowsAfter(market, now.add(SETTLE_WINDOW), MAX_FINDINGS_PER_CODE),
    );
    for (const row of future) find('audit.row.future', null, row.id, null);

    const report: VerifyReport = {
      marketId,
      mode,
      pinnedHead: pinned?.chainSeq ?? null,
      fromSeq,
      sealsChecked,
      findings,
    };
    this.logger.log({
      msg: 'audit.verify.done',
      marketId,
      mode,
      pinnedHead: report.pinnedHead === null ? null : String(report.pinnedHead),
      sealsChecked,
      findings: findings.length,
      correlationId: context.correlationId,
    });
    return report;
  }

  /** The chain hash a seal must carry on `prev` with `rowHash`; null for an unusable seal. */
  private link(seal: SealRecord, prev: Uint8Array, rowHash: Uint8Array): Uint8Array | null {
    try {
      return chainHashOf({
        hashVersion: seal.hashVersion,
        epoch: seal.epoch,
        prev,
        chainSeq: seal.chainSeq,
        late: seal.late,
        rowHash,
      });
    } catch {
      return null;
    }
  }

  /** Check (d), in one-day slices from the oldest row (full) or the start checkpoint (incremental). */
  private async unsealed(
    market: MarketContext,
    mode: VerifyMode,
    start: SealRecord | null,
    watermark: Watermark,
    find: (code: AuditAlertCode, chainSeq: bigint | null, auditLogId: string | null) => void,
  ): Promise<void> {
    let from: Temporal.Instant | null;
    if (mode === 'incremental' && start !== null) {
      // The window of the late-row scan below the start, so a late row is still judged.
      from = start.auditOccurredAt.subtract(UNSEALED_SLICE);
    } else {
      from = await this.read(market, () => this.store.earliestRowTime(market));
    }
    if (from === null) return;
    while (Temporal.Instant.compare(from, watermark.occurredAt) <= 0) {
      const sliceEnd = from.add(UNSEALED_SLICE);
      const upTo: SealKey =
        Temporal.Instant.compare(sliceEnd, watermark.occurredAt) >= 0
          ? watermark
          : // The slice's end, just before the next slice's first instant.
            {
              occurredAt: sliceEnd.subtract({ milliseconds: 1 }),
              auditLogId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
            };
      const sliceFrom = from;
      let after: SealKey | undefined;
      for (;;) {
        const rows = await this.read(market, () =>
          this.store.unsealedRows(market, CURRENT_EPOCH, sliceFrom, upTo, VERIFY_BATCH_SIZE, after),
        );
        for (const row of rows) find('audit.row.unsealed', null, row.id);
        if (rows.length < VERIFY_BATCH_SIZE) break;
        after = keyOf(rows[rows.length - 1]!);
      }
      from = sliceEnd;
    }
  }

  /** One read-only unit (ADR-0025): no transaction, never retried. */
  private async read<T>(market: MarketContext, work: () => Promise<T>): Promise<T> {
    const result: Result<T, never> = await this.unitOfWork.run(
      market,
      async () => ok(await work()),
      { readOnly: true },
    );
    if (!result.ok) throw new Error('AuditVerifier: a read unit returned err');
    return result.value;
  }
}
