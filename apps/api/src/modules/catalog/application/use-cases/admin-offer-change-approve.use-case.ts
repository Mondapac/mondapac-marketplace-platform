import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import { OfferChangeApprovedAudit } from '../../domain/audit';
import { offerStateWithHandling } from '../../domain/offer';
import type { OfferChangeField } from '../../domain/offer-pending-change';
import type { TagActor } from '../../domain/offer-tag';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import { parseChangeDecision, type ChangeValidationFailure } from '../offer-change-view';
import { clearanceFromApproval } from '../offer-review-clearance';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferPendingChangeRepository } from '../ports/offer-pending-change.repository';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { ClaimQueryBuilder } from '../tags/claim-query-builder';
import {
  askPrepared,
  claimsFailClosed,
  factsInUnit,
  hashesOf,
  keptTagTypes,
  MAX_CLAIM_ATTEMPTS,
  preparePublishedAsk,
  RETRY,
} from '../tags/offer-claims';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';

export interface AdminOfferChangeApproveInput {
  readonly changeId: string;
  /** An optional note to the seller: 1 to 2000 characters. Never logged. */
  readonly note?: unknown;
}

export interface AdminOfferChangeApproveOutput {
  readonly changeId: string;
  readonly offerId: string;
  readonly status: 'approved';
  /** The watched fields the change held, live now. */
  readonly fields: readonly OfferChangeField[];
}

export type AdminOfferChangeApproveFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'offer-change.not-found' }
  | { readonly code: 'offer-change.not-pending' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | {
      readonly code: 'claim.tag-not-allowed';
      readonly tags: readonly { readonly typeCode: string; readonly reason: string }[];
    }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'conflict.retry' }
  | ChangeValidationFailure;

export interface AdminOfferChangeApproveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly pendingChanges: OfferPendingChangeRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly check: CheckClaimText;
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * `admin-offer-change.approve` (risk-based Offer approval, slice 2c; ADR-0051): a reviewer
 * approves a held change of a live Offer, and its fields go live in one unit, all or nothing.
 * Rule: the key `catalog.product.approve` and the admin population, as the Offer review
 * decisions. Guards, in order: the change exists in the Market (`offer-change.not-found`) and is
 * `pending` (`offer-change.not-pending`); the owner may still sell (`seller.not-eligible`); a held
 * description passes the claim-text control again (the vocabulary may have grown).
 *
 * Then, up to {@link MAX_CLAIM_ATTEMPTS} times: every kept tag (against the state after a held
 * handling) and every requested type with no open tag are asked of certification outside any
 * unit; one unit reads the Offer again under the version that was asked (a held change raises it,
 * so any change since means asking again), approves the change, applies description and handling
 * (`applyApprovedChange`, the attestation cleared off `SEALED_ORIGINAL`), settles the kept tags
 * and adds the requested ones on those decisions. One requested type not allowed fails the whole
 * approval (`claim.tag-not-allowed`, nothing applied, the change stays pending); an unanswered
 * ask is `claim.check-unavailable`. The change's conditional update loses to another decider as
 * `conflict.stale`. Audit row and Offer events in the same unit.
 */
export class AdminOfferChangeApprove extends UseCase<
  AdminOfferChangeApproveInput,
  AdminOfferChangeApproveOutput,
  AdminOfferChangeApproveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-offer-change-approve',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  readonly #logger = new Logger('AdminOfferChangeApprove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferChangeApproveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminOfferChangeApproveInput,
  ): Promise<Result<AdminOfferChangeApproveOutput, AdminOfferChangeApproveFailure>> {
    const result = await this.#approve(context, input);
    this.#logger.log({
      msg: 'catalog.admin-offer-change-approve',
      code: result.ok ? 'approved' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #approve(
    context: CallContext,
    input: AdminOfferChangeApproveInput,
  ): Promise<Result<AdminOfferChangeApproveOutput, AdminOfferChangeApproveFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const parsed = parseChangeDecision(input, 'optional');
    if (!parsed.ok) return parsed;
    const { changeId, note } = parsed.value;
    const { deps } = this;

    const seen = await deps.unitOfWork.run(
      market,
      async () => {
        const change = await deps.pendingChanges.findById(market, changeId);
        return ok(change === null ? null : change.state);
      },
      { readOnly: true },
    );
    if (!seen.ok) return err({ code: 'access.unavailable' });
    if (seen.value === null) return err({ code: 'offer-change.not-found' });
    const held = seen.value;
    if (held.status !== 'pending') return err({ code: 'offer-change.not-pending' });
    if (!(await deps.eligibility.isEligible(context, held.sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }

    // The held description, outside any unit (the control opens its own).
    const texts = Object.entries(held.proposedDescription ?? {}).filter(([, text]) => text !== '');
    if (texts.length > 0) {
      const checked = await deps.check.execute(
        context,
        texts.map(([locale, text]) => ({ field: 'offer.description', ref: null, locale, text })),
      );
      if (!checked.ok) {
        return err(
          checked.error.code === 'validation.failed'
            ? { code: 'validation.failed', fields: [{ path: 'description', code: 'invalid' }] }
            : checked.error.code === 'access.denied'
              ? { code: 'access.denied' }
              : { code: 'access.unavailable' },
        );
      }
      // Anything that is not plainly clean refuses, so an unknown verdict can never pass.
      const refused = checked.value.flatMap((verdict) =>
        verdict.code === 'clean' ? [] : (refusalOf(verdict) ?? []),
      );
      if (checked.value.some((verdict) => verdict.code !== 'clean') && refused.length === 0) {
        return err({ code: 'access.unavailable' });
      }
      if (refused.length > 0) return err({ code: 'claim-text.refused', fields: refused });
    }

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await claimsFailClosed(() => this.#attempt(context, changeId, note));
      if (outcome !== RETRY) return outcome;
    }
    return err({ code: 'conflict.retry' });
  }

  async #attempt(
    context: CallContext,
    changeId: Id<'OfferPendingChange'>,
    note: string | null,
  ): Promise<Result<AdminOfferChangeApproveOutput, AdminOfferChangeApproveFailure> | typeof RETRY> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const { deps } = this;

    // Read-only: the Offer, the types to ask and their queries against the state after the change.
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const change = await deps.pendingChanges.findById(market, changeId);
        if (change === null) return ok(null);
        const offer = await deps.offers.findById(market, change.state.offerId);
        if (offer === null) return ok(null);
        const { proposedHandling, proposedTagTypes } = change.state;
        const after =
          proposedHandling === null
            ? offer.state
            : offerStateWithHandling(offer.state, proposedHandling);
        const open = new Set(
          offer.tags.filter((tag) => tag.status !== 'removed').map((tag) => tag.typeCode),
        );
        // A requested type that has an open tag by now needs no new tag.
        const added = proposedTagTypes.filter((type) => !open.has(type));
        const types = [...keptTagTypes(offer), ...added];
        const prepared = await preparePublishedAsk(deps.claims, market, after, types);
        return ok({
          status: change.state.status,
          offerStatus: offer.state.status,
          version: offer.state.version,
          added,
          prepared,
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'offer-change.not-found' });
    const { version, added, prepared } = read.value;
    if (read.value.status !== 'pending' || read.value.offerStatus !== 'published') {
      return err({ code: 'offer-change.not-pending' });
    }
    if (prepared === 'unavailable') return err({ code: 'claim.check-unavailable' });
    // Fail closed: an unanswered ask applies nothing; the reviewer tries again.
    const asked = await askPrepared(deps.evaluator, context, prepared);
    if (!asked.ok) return err(asked.error);
    const hash = hashesOf(prepared);
    const tagActor: TagActor = { kind: 'admin', accountId: actor.accountId };

    try {
      const written = await deps.unitOfWork.run<
        AdminOfferChangeApproveOutput | typeof RETRY,
        AdminOfferChangeApproveFailure
      >(market, async () => {
        const change = await deps.pendingChanges.findById(market, changeId);
        if (change === null) return err({ code: 'offer-change.not-found' } as const);
        const offer = await deps.offers.findById(market, change.state.offerId);
        if (offer === null) return err({ code: 'offer-change.not-found' } as const);
        if (offer.state.version !== version) return ok(RETRY);
        const now = deps.clock.now();
        const approved = change.approve({ accountId: actor.accountId, note, now });
        if (!approved.ok) {
          return err(
            approved.error.code === 'offer-change.note-invalid'
              ? ({
                  code: 'validation.failed',
                  fields: [{ path: 'note', code: 'length' }],
                } as const)
              : ({ code: 'offer-change.not-pending' } as const),
          );
        }
        const review = clearanceFromApproval(change);
        const { proposedDescription, proposedHandling } = change.state;
        const applied = offer.applyApprovedChange({
          description: proposedDescription,
          handling: proposedHandling,
          review,
          now,
        });
        if (!applied.ok) return err({ code: 'offer-change.not-pending' } as const);
        // The facts again, in this unit: a revision published since the ask means asking again.
        const facts = await factsInUnit(deps.claims, market, offer.state.productId, prepared);
        if (facts === RETRY) return ok(RETRY);
        const settled = offer.settleTags({
          facts,
          decisions: asked.value,
          entryPath: applied.value.includes('handling') ? 'handling-change' : 'offer-edit',
          actor: tagActor,
          hash,
          now,
        });
        if (!settled.ok) {
          return settled.error.code === 'claim.inputs-changed'
            ? ok(RETRY)
            : err({ code: 'claim.check-unavailable' } as const);
        }
        if (added.length > 0) {
          if (facts === null) return err({ code: 'claim.check-unavailable' } as const);
          const tagged = offer.addTags({
            tags: added.map((typeCode) => ({ tagId: deps.ids.next<'OfferTag'>(), typeCode })),
            facts,
            decisions: asked.value,
            entryPath: 'tag-add',
            actor: tagActor,
            hash,
            now,
            review,
          });
          if (!tagged.ok) {
            switch (tagged.error.code) {
              case 'claim.inputs-changed':
              case 'tag.exists':
                return ok(RETRY);
              case 'claim.tag-not-allowed':
                // All or nothing: the unit ends with an error, so nothing of it commits.
                return err({ code: 'claim.tag-not-allowed', tags: tagged.error.tags } as const);
              default:
                return err({ code: 'claim.check-unavailable' } as const);
            }
          }
        }
        offer.markReviewChange();
        await deps.offers.save(market, offer, { kind: 'admin', accountId: actor.accountId });
        if (!(await deps.pendingChanges.decide(market, change))) {
          return err({ code: 'conflict.stale' } as const);
        }
        await deps.audit.record(
          context,
          OfferChangeApprovedAudit.entry(offer.state.id, {
            after: { changeId: change.state.id, fields: change.fields },
          }),
        );
        await deps.outbox.append(context, offer.pendingEvents);
        return ok({
          changeId: change.state.id,
          offerId: offer.state.id,
          status: 'approved' as const,
          fields: change.fields,
        });
      });
      if (written.ok && written.value === RETRY) return RETRY;
      return written as Result<AdminOfferChangeApproveOutput, AdminOfferChangeApproveFailure>;
    } catch (error) {
      if (error instanceof StaleAggregateError) return RETRY;
      throw error;
    }
  }
}
