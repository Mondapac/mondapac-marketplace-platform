import type {
  CallContext,
  Id,
  IdGenerator,
  MarketContext,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import {
  OfferChangeHeldAudit,
  OfferChangeSupersededAudit,
  OfferReviewReferredAudit,
} from '../domain/audit';
import type { Offer, OfferHandling } from '../domain/offer';
import {
  OfferPendingChange,
  type OfferChangeSupersededCause,
} from '../domain/offer-pending-change';
import {
  OFFER_REVIEW_POLICY_VERSION,
  offerEditReviewReasons,
  type OfferReviewReason,
} from '../domain/offer-review-policy';
import type { OfferPendingChangeRepository } from './ports/offer-pending-change.repository';
import {
  SAFE_OFFER_REVIEW_SETTINGS,
  type OfferReviewInputs,
  type OfferReviewReferralStore,
  type OfferReviewSettings,
} from './ports/offer-review';

/**
 * The watched part of one edit of a live Offer (slice 2c): only the fields the request changes.
 * One request carries one watched field today (edit: description; set-handling: handling;
 * add-tag: one type), so a held change holds exactly the risky part of its request.
 */
export interface WatchedChange {
  readonly addedBadgeTypes: readonly string[];
  readonly newHandling?: OfferHandling;
  readonly newDescription?: Readonly<Record<string, string>>;
}

/** True when the change touches a watched field (description, handling or a new badge). */
export function isWatched(change: WatchedChange): boolean {
  return (
    change.addedBadgeTypes.length > 0 ||
    change.newHandling !== undefined ||
    change.newDescription !== undefined
  );
}

export interface OfferEditReviewDependencies {
  /** The Market's review settings, read outside any unit. */
  readonly inputs: Pick<OfferReviewInputs, 'settings'>;
  readonly referrals: OfferReviewReferralStore;
  readonly pendingChanges: OfferPendingChangeRepository;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
}

/**
 * The edit rules of a live Offer for the seller's edit use cases (risk-based Offer approval, slice
 * 2c; ADR-0051): the policy's reasons (settings read outside any unit, fail closed), the open
 * change of an Offer, and, in the unit after the Offer was saved (lock order: Offer row, then the
 * pending change, then the referral), the referral, the held change and their audit rows.
 */
export class OfferEditReview {
  constructor(private readonly deps: OfferEditReviewDependencies) {}

  /**
   * The reasons this watched change is held; empty means apply at once. Outside any unit. Any
   * failure to read the settings is the safe answer (mode `all`): the change is held, never
   * published by default.
   */
  async reasons(
    context: CallContext,
    change: WatchedChange,
  ): Promise<readonly OfferReviewReason[]> {
    let settings: OfferReviewSettings;
    try {
      settings = await this.deps.inputs.settings(context);
    } catch {
      settings = SAFE_OFFER_REVIEW_SETTINGS;
    }
    return offerEditReviewReasons({
      mode: settings.mode,
      certificateBadges: settings.certificateBadges,
      ...change,
    });
  }

  /** The Offer's open change, or null; in the caller's unit. */
  openChange(market: MarketContext, offerId: Id<'Offer'>): Promise<OfferPendingChange | null> {
    return this.deps.pendingChanges.findOpenByOffer(market, offerId);
  }

  /**
   * In the unit, after the Offer was saved: sets `replaced` aside (`resubmitted`), then records
   * the decision on this watched change. With no reason the change was applied: one `edit`
   * referral with no reason. With reasons the change is held: a `pending` change of the watched
   * fields, its referral and audit rows. Answers the held change's id, or null. The caller has
   * raised the Offer's version for a held or replaced change ({@link Offer.markReviewChange}).
   */
  async settle(
    context: CallContext,
    input: {
      readonly offer: Offer;
      /** The Offer version the edit was made against. */
      readonly baseVersion: number;
      readonly reasons: readonly OfferReviewReason[];
      readonly change: WatchedChange;
      readonly replaced: OfferPendingChange | null;
      readonly now: Temporal.Instant;
    },
  ): Promise<Id<'OfferPendingChange'> | null> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') throw new Error('settle: an authenticated actor only');
    const { offer, reasons, change, now } = input;
    if (input.replaced !== null) await this.supersede(context, input.replaced, 'resubmitted', now);
    let changeId: Id<'OfferPendingChange'> | null = null;
    if (reasons.length > 0) {
      const proposed = OfferPendingChange.propose({
        id: this.deps.ids.next<'OfferPendingChange'>(),
        marketId: market.marketId,
        offerId: offer.state.id,
        sellerId: offer.state.sellerId,
        baseOfferVersion: input.baseVersion,
        proposedDescription: change.newDescription ?? null,
        proposedHandling: change.newHandling ?? null,
        proposedTagTypes: change.addedBadgeTypes,
        reasons,
        policyVersion: OFFER_REVIEW_POLICY_VERSION,
        submittedByAccountId: actor.accountId,
        now,
      });
      if (!proposed.ok) throw new Error(`settle: ${proposed.error.code}`);
      await this.deps.pendingChanges.insert(market, proposed.value);
      changeId = proposed.value.state.id;
      await this.deps.audit.record(
        context,
        OfferChangeHeldAudit.entry(offer.state.id, {
          after: {
            changeId,
            fields: proposed.value.fields,
            reasons,
            policyVersion: OFFER_REVIEW_POLICY_VERSION,
          },
        }),
      );
    }
    await this.deps.referrals.record(market, {
      offerId: offer.state.id,
      sellerId: offer.state.sellerId,
      offerVersion: offer.state.version,
      trigger: 'edit',
      reasons,
      policyVersion: OFFER_REVIEW_POLICY_VERSION,
      decidedAt: now,
      pendingChangeId: changeId,
    });
    await this.deps.audit.record(
      context,
      OfferReviewReferredAudit.entry(offer.state.id, {
        after: {
          trigger: 'edit',
          outcome: changeId === null ? 'published' : 'queued',
          reasons,
          policyVersion: OFFER_REVIEW_POLICY_VERSION,
        },
      }),
    );
    return changeId;
  }

  /**
   * In the unit of a delete, after the Offer was saved: its open change, if any, is set aside
   * (`offer-deleted`) with its audit row. The delete itself raised the Offer's version.
   */
  async supersedeOnDelete(
    context: CallContext,
    offerId: Id<'Offer'>,
    now: Temporal.Instant,
  ): Promise<void> {
    const open = await this.deps.pendingChanges.findOpenByOffer(context.market, offerId);
    if (open !== null) await this.supersede(context, open, 'offer-deleted', now);
  }

  async supersede(
    context: CallContext,
    change: OfferPendingChange,
    cause: OfferChangeSupersededCause,
    now: Temporal.Instant,
  ): Promise<void> {
    const set = change.supersede({ cause, now });
    if (!set.ok) throw new StaleAggregateError('offer-pending-change', change.state.id);
    // Another unit decided it since the read: this unit asks again.
    if (!(await this.deps.pendingChanges.decide(context.market, change))) {
      throw new StaleAggregateError('offer-pending-change', change.state.id);
    }
    await this.deps.audit.record(
      context,
      OfferChangeSupersededAudit.entry(change.state.offerId, {
        after: { changeId: change.state.id, fields: change.fields, cause },
      }),
    );
  }
}
