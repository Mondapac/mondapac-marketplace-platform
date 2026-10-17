import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import {
  StaleAggregateError,
  TransactionConflictError,
} from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SellerCertificationExpiredAudit } from '../../domain/audit';
import {
  SellerCertificationExpired,
  SellerCertificationExpiryWarningDue,
} from '../../domain/events';
import {
  candidateHorizon,
  expiryActionAt,
  type CurrentZones,
  type ExpiryAction,
} from '../../domain/expiry';
import type { SellerZoneAnswer, SellerZonesSource } from '../ports/claim-facts.ports';
import type {
  ExpiryCandidate,
  ExpiryCursor,
  ExpiryPage,
  ExpiryPolicyProvider,
  SellerCertificateExpiryRepository,
} from '../ports/expiry.repository';

/** Candidates read per page (design 8.6: bounded batches of 100; one unit per record). */
export const EXPIRY_BATCH_SIZE = 100;
/** At most this many pages per run; the next run (15 minutes) continues. */
export const MAX_EXPIRY_PAGES_PER_RUN = 50;
const LOCK_TIMEOUT_MS = 3000;

export interface ExpireSellerCertificatesOutput {
  /** Rows read (approved, with a stored boundary inside the window). */
  readonly examined: number;
  readonly expired: number;
  readonly warned: number;
  /** Records another writer had just changed or locked; the next run looks again. */
  readonly contended: number;
  /** Records whose state no longer called for the planned step under the lock. */
  readonly changed: number;
  /** Records whose write failed for another reason (logged); the run is marked failed. */
  readonly failed: number;
  /** Selected rows that cannot be a candidate (approved without an approved decision); logged. */
  readonly inconsistent: number;
  /** Pages whose zone read failed: only the stored boundaries counted for them. */
  readonly zoneReadsFailed: number;
  /** The run stopped at the page cap with candidates left. */
  readonly capped: boolean;
}

export type ExpireSellerCertificatesFailure = { readonly code: 'access.denied' };

export interface ExpiryDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly expiries: SellerCertificateExpiryRepository;
  readonly zones: SellerZonesSource;
  readonly policies: ExpiryPolicyProvider;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

type Applied = 'expired' | 'warned' | 'changed' | 'contended' | 'failed';

/**
 * `certification.expiry-and-warnings` (certification design 3.1, 8.6; AC 8, AC 9; CERT-14,
 * CERT-15): rule `system`, one call per hosted Market. Moves `approved` certificates whose
 * boundary in the seller's local time has passed to `expired` (one event, one audit row and one
 * history row each) and records each due warning once (one marker per approved submission and
 * threshold, with its event). The claim never waits for this: `evaluateClaims` reads the boundary
 * (2.4 rule 4).
 *
 * Per page: the candidates in a read-only unit (A9), the sellers' approved zones outside any unit
 * (the `system` pair of `approvedSellerZones`), the decision in the domain, then one read-write
 * unit per record that acts: lock first (the version guard moves the root's version and takes the
 * row lock), read again, decide again with the same instant and zones, write. A concurrent run
 * finds the version moved and skips; a re-run finds the status or the marker and does nothing.
 */
export class ExpireSellerCertificates extends UseCase<
  Record<string, never>,
  ExpireSellerCertificatesOutput,
  ExpireSellerCertificatesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.expire-seller-certificates',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ExpireSellerCertificates');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ExpiryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ExpireSellerCertificatesOutput, ExpireSellerCertificatesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const now = deps.clock.now();

    // Every hosted Market has a policy (start-up check); none is a fault that fails the run.
    const thresholds = deps.policies.policyFor(market).warningThresholdsDays;
    const horizon = candidateHorizon(now, thresholds);

    const counts = {
      examined: 0,
      expired: 0,
      warned: 0,
      contended: 0,
      changed: 0,
      failed: 0,
      inconsistent: 0,
    };
    let zoneReadsFailed = 0;
    let capped = false;
    let cursor: ExpiryCursor | null = null;
    for (let page = 0; ; page += 1) {
      if (page === MAX_EXPIRY_PAGES_PER_RUN) {
        capped = true;
        break;
      }
      const after: ExpiryCursor | null = cursor;
      const read: Result<ExpiryPage, never> = await deps.unitOfWork.run(
        market,
        async () => ok(await deps.expiries.candidates(market, horizon, after, EXPIRY_BATCH_SIZE)),
        { readOnly: true },
      );
      if (!read.ok) break;
      const { candidates: batch, rawCount, last, inconsistent }: ExpiryPage = read.value;
      if (rawCount === 0 || last === null) break;
      counts.examined += rawCount;
      if (inconsistent > 0) {
        counts.inconsistent += inconsistent;
        this.#logger.warn({
          msg: 'certification.expiry-and-warnings.inconsistent-rows',
          inconsistent,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }

      if (batch.length > 0) {
        // Outside any unit: the sellers' current approved zones (no facade call inside a unit).
        let zones: SellerZoneAnswer | null = null;
        try {
          zones = await deps.zones.zonesOf(context, [...new Set(batch.map((c) => c.sellerId))]);
        } catch {
          zoneReadsFailed += 1;
        }

        for (const candidate of batch) {
          const current = zonesFor(zones, candidate.sellerId);
          const planned = expiryActionAt(candidate, current, thresholds, now);
          if (planned.kind === 'none') continue;
          const outcome = await this.apply(context, candidate, current, thresholds, planned, now);
          counts[outcome] += 1;
        }
      }

      // The cursor and the stop condition come from the raw rows (Mojtaba C1, Hassan L1).
      cursor = last;
      if (rawCount < EXPIRY_BATCH_SIZE) break;
    }

    const output: ExpireSellerCertificatesOutput = { ...counts, zoneReadsFailed, capped };
    this.#logger.log({
      msg: 'certification.expiry-and-warnings.done',
      ...output,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }

  /** One record in one unit: lock first, read and decide again, then write. */
  private async apply(
    context: CallContext,
    candidate: ExpiryCandidate,
    zones: CurrentZones | null,
    thresholds: readonly number[],
    planned: Exclude<ExpiryAction, { kind: 'none' }>,
    now: Temporal.Instant,
  ): Promise<Applied> {
    const { deps } = this;
    const { market } = context;
    const historyId = deps.ids.next<'CertificationHistory'>();
    try {
      const result = await deps.unitOfWork.run<Applied, 'changed'>(
        market,
        async () => {
          await deps.expiries.lockVersion(market, candidate.certificateId, candidate.version, now);
          const again = await deps.expiries.candidate(market, candidate.certificateId);
          if (again === null || again.submissionId !== candidate.submissionId) {
            return err('changed' as const);
          }
          // The run's instant and the same zones: under the lock the plan must still hold.
          const action = expiryActionAt(again, zones, thresholds, now);
          if (!sameAction(action, planned)) return err('changed' as const);

          const ids = {
            sellerCertificationId: candidate.certificateId,
            sellerId: candidate.sellerId,
            submissionId: candidate.submissionId,
          };
          const common = {
            aggregateId: candidate.certificateId as Id,
            aggregateVersion: candidate.version + 1,
            occurredAt: now,
          };
          if (planned.kind === 'expire') {
            await deps.expiries.expire(market, {
              certificateId: candidate.certificateId,
              submissionId: candidate.submissionId,
              historyId,
              now,
            });
            await deps.audit.record(
              context,
              SellerCertificationExpiredAudit.entry(candidate.certificateId, {
                after: {
                  submissionId: candidate.submissionId,
                  typeRevisionId: candidate.typeRevisionId,
                },
              }),
            );
            await deps.outbox.append(context, [
              SellerCertificationExpired.record({
                ...common,
                payload: { ...ids, typeId: candidate.typeId },
              }),
            ]);
            return ok('expired' as const);
          }
          await deps.expiries.recordWarning(market, {
            submissionId: candidate.submissionId,
            thresholdDays: planned.thresholdDays,
            now,
          });
          await deps.outbox.append(context, [
            SellerCertificationExpiryWarningDue.record({
              ...common,
              payload: { ...ids, thresholdDays: planned.thresholdDays },
            }),
          ]);
          return ok('warned' as const);
        },
        { lockTimeoutMs: LOCK_TIMEOUT_MS },
      );
      return result.ok ? result.value : 'changed';
    } catch (error) {
      if (error instanceof StaleAggregateError || error instanceof TransactionConflictError) {
        return 'contended';
      }
      // Any other fault of one record: logged and counted, the run goes on, and the job marks
      // the Market's run as failed at the end.
      this.#logger.error({
        msg: 'certification.expiry-and-warnings.record-failed',
        certificateId: candidate.certificateId,
        action: planned.kind,
        marketId: market.marketId,
        correlationId: context.correlationId,
        err: error,
      });
      return 'failed';
    }
  }
}

function sameAction(a: ExpiryAction, b: Exclude<ExpiryAction, { kind: 'none' }>): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'warn' && b.kind === 'warn') return a.thresholdDays === b.thresholdDays;
  return true;
}

function zonesFor(zones: SellerZoneAnswer | null, sellerId: Id<'Seller'>): CurrentZones | null {
  if (zones === null) return null;
  return zones.get(sellerId) ?? null;
}
