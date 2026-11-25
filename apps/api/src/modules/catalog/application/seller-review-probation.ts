import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import {
  SellerReviewRestartedAudit,
  SellerReviewTrustedAudit,
  SellerReviewTrustRevokedAudit,
} from '../domain/audit';
import {
  probationTarget,
  trustStatusOf,
  type SellerReviewStanding,
  type TrustFlags,
} from '../domain/seller-review-standing';
import type { OfferReviewInputs } from './ports/offer-review';
import type { SellerOfferReviewFlagsReader } from './ports/seller-offer-review-flags.reader';
import type { SellerReviewStandingRepository } from './ports/seller-review-standing.repository';

/** What a decision unit needs about the seller, read before the unit (no read inside it). */
export interface ProbationInputs {
  readonly sellerId: Id<'Seller'>;
  /** N read now (the safe 100 when it cannot be read). */
  readonly probationOffers: number;
  /** The seller's Trusted-from-start switch; off when the sellers facade could not answer. */
  readonly flags: TrustFlags;
}

export interface SellerReviewProbationDependencies {
  readonly standings: SellerReviewStandingRepository;
  readonly sellerFlags: SellerOfferReviewFlagsReader;
  readonly inputs: Pick<OfferReviewInputs, 'probationOffers'>;
  readonly audit: AuditWriter;
}

const NOT_TRUSTED_FROM_START: TrustFlags = Object.freeze({
  trustedFromStart: Object.freeze({ on: false, at: null }),
});

/**
 * The probation counter and Trusted of a seller (risk-based Offer approval slice 4; design 5), in
 * the units of the decisions that move it. Lock order: the caller has written the Offer row; this
 * then locks the standing (created lazily). Bulk decisions run each Offer's own unit.
 *
 * - {@link recordApproval}: an admin approved a first publication (`offer.approve`, also from the
 *   bulk decision). Counts whatever the reasons were; auto-publish and approved edits never call
 *   it. In probation only: one credit per product per epoch, then Trusted at the target.
 * - {@link recordChangesNeeded}: an admin asked for changes on a first publication
 *   (`offer.request-changes`). In probation only; the second in a row (seller-wide) restarts.
 * - {@link stampTrust}: the seller's submit, when N was lowered under its count.
 *
 * - {@link revokeForMisconduct}: an admin's misconduct take-down after publication (slice 6).
 */
export class SellerReviewProbation {
  constructor(private readonly deps: SellerReviewProbationDependencies) {}

  /**
   * Outside any unit: N and the seller's Trusted-from-start switch. A failed read of the switch is
   * "off" (the seller is counted as in probation, the stricter answer).
   */
  async prepare(context: CallContext, sellerId: Id<'Seller'>): Promise<ProbationInputs> {
    const [probationOffers, flags] = await Promise.all([
      this.deps.inputs.probationOffers(context),
      this.deps.sellerFlags.flagsOf(context, sellerId).catch(() => null),
    ]);
    return {
      sellerId,
      probationOffers,
      flags: flags === null ? NOT_TRUSTED_FROM_START : { trustedFromStart: flags.trustedFromStart },
    };
  }

  /** In the `offer.approve` unit, after the Offer was saved. */
  async recordApproval(
    context: CallContext,
    prepared: ProbationInputs,
    approved: {
      readonly productId: Id<'Product'>;
      readonly offerId: Id<'Offer'>;
      readonly now: Temporal.Instant;
    },
  ): Promise<void> {
    const { market } = context;
    const { standings } = this.deps;
    const { sellerId, probationOffers } = prepared;
    const standing = await standings.lock(market, sellerId, approved.now);
    const { epoch } = standing.state;
    // Trusted from start (and not stamped): not in probation, nothing to count.
    const before = await standings.count(market, sellerId, epoch);
    if (this.#status(standing, before, prepared).source === 'admin') return;
    if (standing.state.trustedAt !== null) return;
    await standings.credit(market, {
      sellerId,
      epoch,
      productId: approved.productId,
      offerId: approved.offerId,
      creditedAt: approved.now,
    });
    const count = await standings.count(market, sellerId, epoch);
    const outcome = standing.recordApproval({ count, probationOffers, now: approved.now });
    if (standing.changed) await standings.save(market, standing);
    if (outcome === 'trusted') await this.#trusted(context, standing, count, probationOffers);
  }

  /** In the `offer.request-changes` unit, after the Offer was saved. */
  async recordChangesNeeded(
    context: CallContext,
    prepared: ProbationInputs,
    now: Temporal.Instant,
  ): Promise<void> {
    const { market } = context;
    const { standings } = this.deps;
    const { sellerId, probationOffers } = prepared;
    const standing = await standings.lock(market, sellerId, now);
    const count = await standings.count(market, sellerId, standing.state.epoch);
    const status = this.#status(standing, count, prepared);
    if (status.status === 'trusted') {
      // Trusted by a count N was lowered under: stamp it now; Changes needed no longer count.
      if (standing.stampTrust({ count, probationOffers, now })) {
        await standings.save(market, standing);
        await this.#trusted(context, standing, count, probationOffers);
      }
      return;
    }
    const outcome = standing.recordChangesNeeded({ now });
    if (standing.changed) await standings.save(market, standing);
    if (outcome === 'restarted') {
      await this.deps.audit.record(
        context,
        SellerReviewRestartedAudit.entry(sellerId, { after: { epoch: standing.state.epoch } }),
      );
    }
  }

  /**
   * In the seller's submit unit, after the Offer was saved, when the facts said the count meets a
   * lowered N but `trusted_at` is not stamped: stamps it (checked again under the lock).
   */
  async stampTrust(
    context: CallContext,
    input: {
      readonly sellerId: Id<'Seller'>;
      readonly probationOffers: number;
      readonly now: Temporal.Instant;
    },
  ): Promise<void> {
    const { market } = context;
    const { standings } = this.deps;
    const standing = await standings.lock(market, input.sellerId, input.now);
    const count = await standings.count(market, input.sellerId, standing.state.epoch);
    if (!standing.stampTrust({ count, probationOffers: input.probationOffers, now: input.now })) {
      return;
    }
    await standings.save(market, standing);
    await this.#trusted(context, standing, count, input.probationOffers);
  }

  /**
   * In the take-down unit, after the Offer row (lock order: Offer, then standing): Trusted is lost
   * and a new epoch opens with the after-misconduct target, whatever the seller's status was. A
   * seller with no standing yet gets one started, then revoked. Audited with the new epoch.
   */
  async revokeForMisconduct(
    context: CallContext,
    input: { readonly sellerId: Id<'Seller'>; readonly now: Temporal.Instant },
  ): Promise<void> {
    const { market } = context;
    const { standings } = this.deps;
    const standing = await standings.lock(market, input.sellerId, input.now);
    standing.revokeForMisconduct({ now: input.now });
    await standings.save(market, standing);
    await this.deps.audit.record(
      context,
      SellerReviewTrustRevokedAudit.entry(input.sellerId, {
        after: { epoch: standing.state.epoch },
      }),
    );
  }

  #status(standing: SellerReviewStanding, count: number, prepared: ProbationInputs) {
    return trustStatusOf({ ...standing.state, count }, prepared.flags, prepared.probationOffers);
  }

  async #trusted(
    context: CallContext,
    standing: SellerReviewStanding,
    count: number,
    probationOffers: number,
  ): Promise<void> {
    const { epoch, targetKind, sellerId } = standing.state;
    await this.deps.audit.record(
      context,
      SellerReviewTrustedAudit.entry(sellerId, {
        after: { epoch, count, target: probationTarget(targetKind, probationOffers) },
      }),
    );
  }
}
