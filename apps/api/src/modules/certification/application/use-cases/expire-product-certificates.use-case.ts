import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  IdGenerator,
  MarketContext,
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
import type { TimeZoneId } from '../../domain/claim-types';
import { ProductCertificationExpiredAudit } from '../../domain/audit';
import {
  ProductCertificationExpired,
  ProductCertificationExpiryWarningDue,
} from '../../domain/events';
import { candidateHorizon, type ExpiryAction } from '../../domain/expiry';
import { productExpiryActionAt } from '../../domain/product-certification-lifecycle';
import type { ExpiryPolicyProvider } from '../ports/expiry.repository';
import type {
  ProductCertificationRepository,
  ProductExpiryCandidate,
  ProductExpiryPage,
} from '../ports/product-certification.repository';
import { EXPIRY_BATCH_SIZE, MAX_EXPIRY_PAGES_PER_RUN } from './expire-seller-certificates.use-case';

const LOCK_TIMEOUT_MS = 3000;

export interface ExpireProductCertificatesOutput {
  readonly examined: number;
  readonly expired: number;
  readonly warned: number;
  readonly contended: number;
  readonly changed: number;
  readonly failed: number;
  readonly inconsistent: number;
  /** The Market's configured zone was not usable: only the stored boundaries counted. */
  readonly marketZoneMissing: boolean;
  readonly capped: boolean;
}

export type ExpireProductCertificatesFailure = { readonly code: 'access.denied' };

export interface ProductExpiryDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductCertificationRepository;
  readonly policies: ExpiryPolicyProvider;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The Market's configured zone; null when it is not usable. */
  readonly marketZone: (market: MarketContext) => TimeZoneId | null;
}

type Applied = 'expired' | 'warned' | 'changed' | 'contended' | 'failed';

/**
 * The manufacturer half of `certification.expiry-and-warnings` (certification design 3.4 row 9,
 * 8.6: "Manufacturer certificates in the Market zone, same"; slice 15): rule `system`, one call per
 * hosted Market. Moves `approved` manufacturer certificates whose boundary has passed to `expired`
 * (one history row, one audit row and `product-certification-expired.v1` each) and records each
 * due warning once (one marker per approved revision and threshold, kind `product-revision`, with
 * `product-certification-expiry-warning-due.v1`). The boundary is the claim's: the one stored at
 * approval, or the one in the Market's current zone when earlier; warnings count Market days.
 *
 * Per page: the candidates in a read-only unit (A9 on `product_certifications`), the decision in
 * the domain, then one read-write unit per record that acts: lock first (the root's version),
 * read again, decide again with the same instant, write. A concurrent run finds the version moved
 * and skips; a re-run finds the status or the marker and does nothing. The claim never waits for
 * this: `evaluateClaims` reads the boundary (2.4 rule 4).
 */
export class ExpireProductCertificates extends UseCase<
  Record<string, never>,
  ExpireProductCertificatesOutput,
  ExpireProductCertificatesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.expire-product-certificates',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ExpireProductCertificates');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductExpiryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ExpireProductCertificatesOutput, ExpireProductCertificatesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const now = deps.clock.now();
    const thresholds = deps.policies.policyFor(market).warningThresholdsDays;
    const marketZone = deps.marketZone(market);
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
    let capped = false;
    let cursor: ProductExpiryPage['last'] = null;
    for (let page = 0; ; page += 1) {
      if (page === MAX_EXPIRY_PAGES_PER_RUN) {
        capped = true;
        break;
      }
      const after: ProductExpiryPage['last'] = cursor;
      const read: Result<ProductExpiryPage, never> = await deps.unitOfWork.run(
        market,
        async () =>
          ok(await deps.products.expiryCandidates(market, horizon, after, EXPIRY_BATCH_SIZE)),
        { readOnly: true },
      );
      if (!read.ok) break;
      const { candidates, rawCount, last, inconsistent }: ProductExpiryPage = read.value;
      if (rawCount === 0 || last === null) break;
      counts.examined += rawCount;
      if (inconsistent > 0) {
        counts.inconsistent += inconsistent;
        this.#logger.warn({
          msg: 'certification.expiry-and-warnings.product-inconsistent-rows',
          inconsistent,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
      for (const candidate of candidates) {
        const planned = productExpiryActionAt(candidate, marketZone, thresholds, now);
        if (planned.kind === 'none') continue;
        const outcome = await this.apply(context, candidate, marketZone, thresholds, planned, now);
        counts[outcome] += 1;
      }
      cursor = last;
      if (rawCount < EXPIRY_BATCH_SIZE) break;
    }

    const output: ExpireProductCertificatesOutput = {
      ...counts,
      marketZoneMissing: marketZone === null,
      capped,
    };
    this.#logger.log({
      msg: 'certification.expiry-and-warnings.products-done',
      ...output,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }

  /** One record in one unit: lock first, read and decide again, then write. */
  private async apply(
    context: CallContext,
    candidate: ProductExpiryCandidate,
    marketZone: TimeZoneId | null,
    thresholds: readonly number[],
    planned: Exclude<ExpiryAction, { kind: 'none' }>,
    now: Temporal.Instant,
  ): Promise<Applied> {
    const { deps } = this;
    const { market } = context;
    const historyId = deps.ids.next<'ProductCertificationHistory'>();
    try {
      const result = await deps.unitOfWork.run<Applied, 'changed'>(
        market,
        async () => {
          await deps.products.lock(market, candidate.certificateId, candidate.version, now);
          const again = await deps.products.expiryCandidate(market, candidate.certificateId);
          if (again === null || again.approvedRevisionId !== candidate.approvedRevisionId) {
            return err('changed' as const);
          }
          const action = productExpiryActionAt(again, marketZone, thresholds, now);
          if (!sameAction(action, planned)) return err('changed' as const);
          const common = {
            aggregateId: candidate.certificateId,
            aggregateVersion: candidate.version + 1,
            occurredAt: now,
          };
          const ids = {
            productCertificationId: candidate.certificateId,
            revisionId: candidate.approvedRevisionId,
            typeId: candidate.typeId,
          };
          if (planned.kind === 'expire') {
            await deps.products.transition(market, {
              certificateId: candidate.certificateId,
              approvedRevisionId: candidate.approvedRevisionId,
              fromStatus: 'approved',
              toStatus: 'expired',
              withdrawn: null,
              reasonCode: null,
              noteCiphertext: null,
              actorAccountId: null,
              historyId,
              now,
            });
            await deps.audit.record(
              context,
              ProductCertificationExpiredAudit.entry(candidate.certificateId, {
                after: {
                  revisionId: candidate.approvedRevisionId,
                  typeRevisionId: candidate.typeRevisionId,
                },
              }),
            );
            await deps.outbox.append(context, [
              ProductCertificationExpired.record({ ...common, payload: ids }),
            ]);
            return ok('expired' as const);
          }
          await deps.products.recordWarning(market, {
            revisionId: candidate.approvedRevisionId,
            thresholdDays: planned.thresholdDays,
            now,
          });
          await deps.outbox.append(context, [
            ProductCertificationExpiryWarningDue.record({
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
      this.#logger.error({
        msg: 'certification.expiry-and-warnings.product-failed',
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
