import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result, Temporal } from '@mondapac/shared-kernel';
import {
  OfferChangesRequested,
  OfferCreated,
  OfferDeleted,
  OfferListingChanged,
  OfferPublished,
  OfferTagAdded,
  OfferTagBasisSwitched,
  OfferTagRemoved,
  OfferTagRestored,
  OfferTagSuspended,
  type OfferChangeReason,
} from './events';
import {
  canonicalClaimInputs,
  claimQueriesFor,
  judgeTag,
  tagCopyKey,
  type ClaimFacts,
  type OfferTagPendingHistory,
  type OfferTagState,
  type OfferTagStatus,
  type TagActor,
  type TagDecision,
  type TagEntryPath,
  type TagJudgement,
} from './offer-tag';

import { OFFER_HANDLINGS, type OfferHandling } from './offer-handling';
export const OFFER_STATUSES = [
  'draft',
  'pending-first-publish',
  'changes-needed',
  'published',
  'deleted',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export { OFFER_HANDLINGS, type OfferHandling };

/**
 * The stored causes that take a published Offer off sale (catalog design 2.3 M-5, 4.4). A cause
 * from another module (may-sell, price, stock) is never stored here.
 */
export const OFF_SALE_CAUSES = [
  'type-not-allowed',
  'product-retired',
  'product-not-listed',
  'tag-suspended',
  'description-claim-text',
] as const;
export type OffSaleCause = (typeof OFF_SALE_CAUSES)[number];

/** The statuses a write that keeps tags asks again (design 5.2, 5.3). */
const KEPT_STATUSES: readonly OfferTagStatus[] = ['active', 'rechecking', 'suspended'];

/** Why a command was refused: a stable code, never data. */
export type OfferRefusal =
  | { readonly code: 'offer.sku-invalid' }
  | { readonly code: 'offer.condition-invalid' }
  | { readonly code: 'offer.description-invalid' }
  | { readonly code: 'offer.not-editable' };

/**
 * Why a tag command was refused (catalog design 5.2, 5.3). `claim.tag-not-allowed` names each
 * refused type with the `ClaimReason` code of its first refused variant (CUX 3.7 words come from
 * the code); `claim.inputs-changed` means a returned input differs from the state being saved, and
 * the use case asks again (5.2 point 3).
 */
export type OfferTagRefusal =
  | { readonly code: 'offer.not-taggable' }
  | { readonly code: 'offer.handling-missing' }
  | { readonly code: 'tag.product-not-published' }
  | { readonly code: 'tag.exists' }
  | { readonly code: 'tag.not-found' }
  | { readonly code: 'tag.suspended' }
  | { readonly code: 'tag.not-removable' }
  | { readonly code: 'tag.not-suspended' }
  | {
      readonly code: 'claim.tag-not-allowed';
      readonly tags: readonly { readonly typeCode: string; readonly reason: string }[];
    }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'claim.inputs-changed' };

/** What a re-ask of the kept tags changed (design 5.3), for the use case's log line. */
export interface TagSettlement {
  readonly kept: number;
  readonly suspended: number;
  readonly restored: number;
  readonly switched: number;
}

/** A type's verdict and the hash of the inputs it was judged on. */
interface JudgedTag {
  readonly judgement: TagJudgement;
  readonly inputsHash: string | null;
}

/** The input every claim-bearing command passes with the decisions it asked for. */
interface ClaimAnswerInput {
  readonly facts: ClaimFacts;
  /** Per type code, the decisions in the order of the facts' variants. */
  readonly decisions: ReadonlyMap<string, readonly TagDecision[]>;
  readonly entryPath: TagEntryPath;
  readonly actor: TagActor;
  /** SHA-256 hex of a canonical text (the domain holds no crypto). */
  readonly hash: (canonical: string) => string;
  readonly now: Temporal.Instant;
  /** The consumed event of a handler or job change, recorded on its history rows. */
  readonly causeEventId?: Id | null;
}

/** Why `setHandling` was refused. */
type OfferHandlingRefusal =
  { readonly code: 'offer.handling-invalid' } | { readonly code: 'offer.not-editable' };

/** Why a status transition (submit, approve, request changes, delete) was refused. */
export type OfferTransitionRefusal =
  | { readonly code: 'offer.not-submittable' }
  | { readonly code: 'offer.handling-missing' }
  | { readonly code: 'offer.not-pending-review' }
  | { readonly code: 'offer.already-deleted' };

/** The history row a change leaves (data design 3.14); field ids only, never values. */
export interface OfferPendingHistory {
  readonly changeKind:
    | 'edited'
    | 'submitted'
    | 'published'
    | 'publication-approved'
    | 'changes-requested'
    | 'causes-changed'
    | 'deleted';
  readonly changedFields: readonly string[];
  readonly occurredAt: Temporal.Instant;
}

export interface OfferState {
  readonly id: Id<'Offer'>;
  readonly marketId: MarketId;
  /** The seller who owns the Offer; never changes (pricing's copy relies on it, PRC 2.3). */
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  /** One per Offer, unique per seller among non-deleted Offers (CAT-10). */
  readonly sellerSku: string;
  readonly conditionCode: string;
  /** Locale to text; claim-checked by the use case (catalog design 6). */
  readonly description: Readonly<Record<string, string>>;
  readonly handling: OfferHandling | null;
  readonly attestationRecordedAt: Temporal.Instant | null;
  readonly attestationAccountId: Id<'Account'> | null;
  readonly status: OfferStatus;
  readonly offSaleCauses: readonly OffSaleCause[];
  /** Stored: `published` and no cause (data design 3.13 `offers_listed_check`). */
  readonly listed: boolean;
  readonly submittedAt: Temporal.Instant | null;
  readonly firstPublishedAt: Temporal.Instant | null;
  readonly deletedAt: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

/** Listed means published with no off-sale cause; the product's own state is held by the transitions. */
export function isListed(state: Pick<OfferState, 'status' | 'offSaleCauses'>): boolean {
  return state.status === 'published' && state.offSaleCauses.length === 0;
}

/** Printable ASCII without whitespace, 1 to 64 characters (data design 3.13 `seller_sku`). */
const SKU_PATTERN = /^[!-~]{1,64}$/;
/** A vocabulary code (data design CA4). */
const CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** The most characters one locale of an Offer description may hold (Hassan L-2). */
export const MAX_DESCRIPTION_CHARS = 5000;
/** The most locales one Offer description may hold. */
export const MAX_DESCRIPTION_LOCALES = 20;

function sortedEntries(value: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function validDescription(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_DESCRIPTION_LOCALES &&
    entries.every(
      ([locale, text]) =>
        locale.length > 0 &&
        locale.length <= 35 &&
        typeof text === 'string' &&
        text.length <= MAX_DESCRIPTION_CHARS,
    )
  );
}

/**
 * An Offer: one seller's listing of one product (catalog design 2.1, 4.4). This part holds
 * creation and the stored shape; the transitions arrive with their use cases. A new Offer is a
 * `draft` with no handling, attestation or cause, so it is never listed.
 *
 * Version rule as `Product` (Q-K3): a change raises the version by one, plus one more per event
 * beyond the first, and the n-th new event carries the n-th version.
 */
export class Offer {
  #state: OfferState;
  readonly #events: PendingEvent[] = [];
  readonly #persistedVersion: number | null;
  #pendingHistory: OfferPendingHistory | null = null;
  /** The tags in their stored order (an entity of the Offer: a change raises the root version). */
  #tags: OfferTagState[];
  readonly #tagHistory: OfferTagPendingHistory[] = [];
  readonly #newTagIds = new Set<string>();
  readonly #changedTagIds = new Set<string>();
  /** Each stored tag's `change_seq` as read: the guard of its update (Mojtaba F2). */
  readonly #readChangeSeqs: ReadonlyMap<string, number>;
  /** False for a read-only projection built without its tags: such an Offer is never saved (I1). */
  readonly #tagsLoaded: boolean;

  private constructor(
    state: OfferState,
    persistedVersion: number | null,
    tags: readonly OfferTagState[] | null,
  ) {
    this.#state = Object.freeze(state);
    this.#persistedVersion = persistedVersion;
    this.#tagsLoaded = tags !== null;
    this.#tags = (tags ?? []).map((tag) => Object.freeze({ ...tag }));
    this.#readChangeSeqs = new Map(this.#tags.map((tag) => [tag.id, tag.changeSeq]));
  }

  /**
   * A new draft Offer. Handling, attestation and tags are never inputs here (brief s5, B1):
   * they are written only by their own commands of a seller actor.
   */
  static create(input: {
    readonly id: Id<'Offer'>;
    readonly marketId: MarketId;
    readonly sellerId: Id<'Seller'>;
    readonly productId: Id<'Product'>;
    readonly sellerSku: string;
    readonly conditionCode: string;
    readonly description: Readonly<Record<string, string>>;
    readonly now: Temporal.Instant;
  }): Result<Offer, OfferRefusal> {
    if (typeof input.sellerSku !== 'string' || !SKU_PATTERN.test(input.sellerSku)) {
      return err({ code: 'offer.sku-invalid' });
    }
    if (typeof input.conditionCode !== 'string' || !CODE_PATTERN.test(input.conditionCode)) {
      return err({ code: 'offer.condition-invalid' });
    }
    if (!validDescription(input.description)) return err({ code: 'offer.description-invalid' });
    const offer = new Offer(
      {
        id: input.id,
        marketId: input.marketId,
        sellerId: input.sellerId,
        productId: input.productId,
        sellerSku: input.sellerSku,
        conditionCode: input.conditionCode,
        description: Object.freeze({ ...input.description }),
        handling: null,
        attestationRecordedAt: null,
        attestationAccountId: null,
        status: 'draft',
        offSaleCauses: [],
        listed: false,
        submittedAt: null,
        firstPublishedAt: null,
        deletedAt: null,
        version: 1,
        createdAt: input.now,
      },
      null,
      [],
    );
    offer.#events.push(
      OfferCreated.record({
        aggregateId: input.id,
        aggregateVersion: 1,
        occurredAt: input.now,
        payload: { offerId: input.id, productId: input.productId, sellerId: input.sellerId },
      }),
    );
    return ok(offer);
  }

  /**
   * A seller's edit of the content fields (SKU, condition, description): a closed set with no
   * handling, attestation or tag (B1). A `pending-first-publish` or `changes-needed` Offer returns
   * to `draft` and leaves the queue; a published Offer stays published with no queue (design 4.4,
   * M-3): its use case re-asks every kept tag in the same unit (`settleTags`, AC 11, AC 33).
   * Answers the field ids that changed; an edit of a draft or a published Offer that changes
   * nothing stores nothing and leaves the version alone.
   */
  edit(input: {
    readonly sellerSku: string;
    readonly conditionCode: string;
    readonly description: Readonly<Record<string, string>>;
    readonly now: Temporal.Instant;
  }): Result<readonly string[], OfferRefusal> {
    const state = this.#state;
    if (state.status === 'deleted') return err({ code: 'offer.not-editable' });
    if (typeof input.sellerSku !== 'string' || !SKU_PATTERN.test(input.sellerSku)) {
      return err({ code: 'offer.sku-invalid' });
    }
    if (typeof input.conditionCode !== 'string' || !CODE_PATTERN.test(input.conditionCode)) {
      return err({ code: 'offer.condition-invalid' });
    }
    if (!validDescription(input.description)) return err({ code: 'offer.description-invalid' });
    const changed: string[] = [];
    if (input.sellerSku !== state.sellerSku) changed.push('sellerSku');
    if (input.conditionCode !== state.conditionCode) changed.push('conditionCode');
    if (
      JSON.stringify(sortedEntries(input.description)) !==
      JSON.stringify(sortedEntries(state.description))
    ) {
      changed.push('description');
    }
    const published = state.status === 'published';
    if (changed.length === 0 && (state.status === 'draft' || published)) return ok([]);
    if (this.#pendingHistory !== null) throw new Error('edit: the Offer already has a change');
    this.#state = Object.freeze({
      ...state,
      sellerSku: input.sellerSku,
      conditionCode: input.conditionCode,
      description: Object.freeze({ ...input.description }),
      ...(published ? {} : { status: 'draft' as const, submittedAt: null }),
      version: state.version + 1,
    });
    this.#pendingHistory = { changeKind: 'edited', changedFields: changed, occurredAt: input.now };
    return ok(changed);
  }

  /**
   * The seller's record of how the Offer's goods are handled (`own-offer.set-handling`, design
   * 4.4, 8.2; B1: a command of its own, never part of `edit`). The same return to `draft` as
   * `edit`; a published Offer stays published and its use case re-asks every kept tag against the
   * new handling in the same unit (`settleTags`; AC 11). Answers the changed field ids
   * (`['handling']` or none); a draft or published Offer that already holds the value stores
   * nothing and leaves the version alone.
   */
  setHandling(input: {
    readonly handling: OfferHandling;
    readonly now: Temporal.Instant;
  }): Result<readonly string[], OfferHandlingRefusal> {
    const state = this.#state;
    if (state.status === 'deleted') return err({ code: 'offer.not-editable' });
    if (!(OFFER_HANDLINGS as readonly unknown[]).includes(input.handling)) {
      return err({ code: 'offer.handling-invalid' });
    }
    const changed = input.handling !== state.handling;
    const published = state.status === 'published';
    if (!changed && (state.status === 'draft' || published)) return ok([]);
    if (this.#pendingHistory !== null)
      throw new Error('setHandling: the Offer already has a change');
    this.#state = Object.freeze({
      ...state,
      handling: input.handling,
      ...(published ? {} : { status: 'draft' as const, submittedAt: null }),
      version: state.version + 1,
    });
    this.#pendingHistory = {
      changeKind: 'edited',
      changedFields: changed ? ['handling'] : [],
      occurredAt: input.now,
    };
    return ok(changed ? ['handling'] : []);
  }

  /**
   * The seller's submit of a `draft` Offer (catalog design 4.4): handling must be present. The
   * Market's `approvalRequired`, read by the caller in the same unit, decides: on, the Offer waits
   * for review (`pending-first-publish`); off, it is `published` at once with `catalog.offer-
   * published.v1`. The claim-text control and the product checks are the use case's.
   */
  submit(input: {
    readonly approvalRequired: boolean;
    readonly now: Temporal.Instant;
  }): Result<{ readonly published: boolean }, OfferTransitionRefusal> {
    const state = this.#state;
    if (state.status !== 'draft') return err({ code: 'offer.not-submittable' });
    if (state.handling === null) return err({ code: 'offer.handling-missing' });
    this.#assertNoChange('submit');
    if (input.approvalRequired) {
      this.#state = Object.freeze({
        ...state,
        status: 'pending-first-publish',
        submittedAt: input.now,
        version: state.version + 1,
      });
      this.#pendingHistory = { changeKind: 'submitted', changedFields: [], occurredAt: input.now };
      return ok({ published: false });
    }
    this.#publish(input.now, 'published', { submittedAt: input.now });
    return ok({ published: true });
  }

  /** A reviewer's approval of an Offer waiting for its first publication (design 4.4). */
  approve(input: { readonly now: Temporal.Instant }): Result<void, OfferTransitionRefusal> {
    if (this.#state.status !== 'pending-first-publish') {
      return err({ code: 'offer.not-pending-review' });
    }
    // The re-ask of the approval (5.1a point 3) settles the tags first, in the same unit; its
    // causes-only change is part of this publication and its history row is this one.
    if (this.#pendingHistory?.changeKind !== 'causes-changed') this.#assertNoChange('approve');
    this.#publish(input.now, 'publication-approved', {});
    return ok(undefined);
  }

  /**
   * A reviewer asks the seller for changes (design 4.4): `pending-first-publish` to
   * `changes-needed`, with the reason as a code on the event. The seller's edit returns it to
   * `draft`.
   */
  requestChanges(input: {
    readonly reasonCode: OfferChangeReason;
    readonly now: Temporal.Instant;
  }): Result<void, OfferTransitionRefusal> {
    const state = this.#state;
    if (state.status !== 'pending-first-publish') {
      return err({ code: 'offer.not-pending-review' });
    }
    this.#assertNoChange('requestChanges');
    const version = state.version + 1;
    this.#state = Object.freeze({ ...state, status: 'changes-needed', version });
    this.#pendingHistory = {
      changeKind: 'changes-requested',
      changedFields: [],
      occurredAt: input.now,
    };
    this.#events.push(
      OfferChangesRequested.record({
        aggregateId: state.id,
        aggregateVersion: version,
        occurredAt: input.now,
        payload: {
          offerId: state.id,
          productId: state.productId,
          sellerId: state.sellerId,
          reasonCode: input.reasonCode,
        },
      }),
    );
    return ok(undefined);
  }

  /**
   * The seller's delete (OFR-06; terminal): any Offer that is not deleted becomes `deleted`, and
   * a listed one stops being listed. The row stays (Q-K2); the event tells pricing and inventory.
   * Every tag that is not removed becomes `removed` with entry path `offer-delete` (data design
   * 3.16; Hassan L5); delete asks nothing (ADR-0028 d5).
   */
  delete(input: {
    readonly now: Temporal.Instant;
    readonly actor?: TagActor;
  }): Result<void, OfferTransitionRefusal> {
    const state = this.#state;
    if (state.status === 'deleted') return err({ code: 'offer.already-deleted' });
    this.#assertNoChange('delete');
    const actor: TagActor = input.actor ?? { kind: 'system', accountId: null };
    for (const tag of this.#tags) {
      if (tag.status === 'removed') continue;
      this.#removeTag(tag, 'offer-delete', actor, input.now);
    }
    const version = state.version + 1;
    this.#state = Object.freeze({
      ...this.#state,
      status: 'deleted',
      listed: false,
      deletedAt: input.now,
      version,
    });
    this.#pendingHistory = { changeKind: 'deleted', changedFields: [], occurredAt: input.now };
    this.#events.push(
      OfferDeleted.record({
        aggregateId: state.id,
        aggregateVersion: version,
        occurredAt: input.now,
        payload: { offerId: state.id, productId: state.productId, sellerId: state.sellerId },
      }),
    );
    return ok(undefined);
  }

  /**
   * Adds tags from fresh decisions of this request (`own-offer.add-tag`, and the requested types
   * of `own-offer.submit` on a published product; design 5.1a point 6, 5.2). All or nothing: every
   * type must be judged allowed for every variant, against inputs equal to this Offer's own state
   * and the facts of the product's published revision (CERT-21 through `evaluateClaims` only;
   * AC 7 to 9, 15). A type that already has a tag that is not removed is `tag.exists`. Each new tag
   * is `active` with its claim copy and badge, a history row and `catalog.offer-tag-added.v1`.
   */
  addTags(
    input: ClaimAnswerInput & {
      readonly tags: readonly { readonly tagId: Id<'OfferTag'>; readonly typeCode: string }[];
    },
  ): Result<void, OfferTagRefusal> {
    const state = this.#state;
    if (state.status === 'deleted') return err({ code: 'offer.not-taggable' });
    if (state.handling === null) return err({ code: 'offer.handling-missing' });
    if (!input.facts.revisionPublished) return err({ code: 'tag.product-not-published' });
    const types = input.tags.map((tag) => tag.typeCode);
    if (
      new Set(types).size !== types.length ||
      types.some((type) => this.#openTag(type) !== undefined)
    ) {
      return err({ code: 'tag.exists' });
    }
    const judged = this.#judgeAll(input, types);
    if (!judged.ok) return judged;
    const refused = types.flatMap((typeCode) => {
      const verdict = judged.value.get(typeCode)!;
      return verdict.judgement.kind === 'not-allowed'
        ? [{ typeCode, reason: verdict.judgement.reason }]
        : [];
    });
    if (refused.length > 0) return err({ code: 'claim.tag-not-allowed', tags: refused });
    for (const { tagId, typeCode } of input.tags) {
      const { judgement, inputsHash } = judged.value.get(typeCode)!;
      if (judgement.kind !== 'allowed') throw new Error('addTags: judged without a verdict');
      const tag: OfferTagState = {
        id: tagId,
        typeCode,
        status: 'active',
        copy: judgement.copy,
        badge: judgement.badge,
        copyRevisionId: input.facts.productRevisionId,
        copyRevisionPublished: true,
        inputsHash,
        lastReasonCode: 'allowed',
        lastChangeCause: input.entryPath,
        evaluatedAt: judgement.evaluatedAt,
        statusChangedAt: input.now,
        changeSeq: 1,
        removedAt: null,
        removedByKind: null,
        removedByAccountId: null,
        createdAt: input.now,
      };
      this.#putTag(tag, true);
      this.#historyOf(tag, null, input.entryPath, input.actor, input.now);
      this.#tagEvent(OfferTagAdded, tag, input.now);
    }
    this.#touch();
    return ok(undefined);
  }

  /**
   * Asks again for every kept tag (`active`, `rechecking`, `suspended`) on a write that changes or
   * keeps a claim input (design 5.2, 5.4 "ask on every write"; AC 11): an edit, a handling change,
   * a submit, a reviewer's approval. The decisions must answer exactly these tags against this
   * Offer's state now and the facts of the product's published revision; one stale answer refuses
   * the whole settle (`claim.inputs-changed`) and one `unavailable` answer refuses it too
   * (`claim.check-unavailable`, fail closed: nothing is activated or kept on a stale copy). Then:
   * allowed keeps or restores the tag `active` with a fresh copy (basis switch recorded); not
   * allowed makes it `suspended` without badge data, which adds the cause `tag-suspended` and takes
   * the Offer off sale (CERT-15). `pending-publish` tags are not touched: they become effective only
   * through the publish re-ask (5.1a point 3).
   */
  settleTags(input: Omit<ClaimAnswerInput, 'facts'> & { readonly facts: ClaimFacts | null }) {
    const kept = this.#tags.filter((tag) => KEPT_STATUSES.includes(tag.status));
    const summary = { kept: 0, suspended: 0, restored: 0, switched: 0 };
    if (kept.length === 0) return ok(summary);
    const facts = input.facts;
    if (facts === null || !facts.revisionPublished || this.#state.handling === null) {
      return err({ code: 'claim.check-unavailable' } as const);
    }
    const types = kept.map((tag) => tag.typeCode);
    const judged = this.#judgeAll({ ...input, facts }, types);
    if (!judged.ok) return judged;
    for (const tag of kept) {
      this.#applyVerdict(tag, judged.value.get(tag.typeCode)!, { ...input, facts }, summary);
    }
    this.#refreshTagCause(input.now);
    this.#touch();
    return ok(summary);
  }

  /**
   * The re-ask of a publication (design 5.1a point 3; 4.2 rows 3, 4; slice 11): every tag that is
   * not removed (`pending-publish` included) is judged on decisions of this request whose inputs
   * name the revision being published, before the pointer moves, in the publish unit. The facts
   * must name that revision as the published one. Fail closed: one stale answer refuses the whole
   * settle (`claim.inputs-changed`, the use case asks again) and one `unavailable` answer refuses
   * it (`claim.check-unavailable`): nothing becomes `active` on a stale or missing answer. Then
   * an allowed tag is `active` with a fresh copy and badge (a `pending-publish` one is announced
   * as added, a `suspended` one as restored); a refused one is `suspended` without badge data,
   * which takes the Offer off sale (cause `tag-suspended`, CERT-15).
   *
   * `requested` is the first submit of a never-published product that publishes at once (5.1a
   * point 6 with no review in between): the open tags must all be `pending-publish`, the tags
   * become exactly the requested set (a type left out is `removed`), and one requested type that
   * is not allowed refuses the whole submit (`claim.tag-not-allowed`), as at a submit that waits.
   */
  settlePublish(
    input: ClaimAnswerInput & {
      readonly requested?: readonly {
        readonly tagId: Id<'OfferTag'>;
        readonly typeCode: string;
      }[];
    },
  ): Result<TagSettlement, OfferTagRefusal> {
    if (!input.facts.revisionPublished) {
      throw new Error('settlePublish: the facts must name the revision being published');
    }
    const summary = { kept: 0, suspended: 0, restored: 0, switched: 0 };
    if (this.#state.status === 'deleted') return err({ code: 'offer.not-taggable' });
    const open = this.#tags.filter((tag) => tag.status !== 'removed');
    const requested = input.requested;
    if (requested === undefined) {
      if (open.length === 0) return ok(summary);
      if (this.#state.handling === null) return err({ code: 'offer.handling-missing' });
      const judged = this.#judgeAll(
        input,
        open.map((tag) => tag.typeCode),
      );
      if (!judged.ok) return judged;
      for (const tag of open) {
        this.#applyVerdict(tag, judged.value.get(tag.typeCode)!, input, summary);
      }
      this.#refreshTagCause(input.now);
      this.#touch();
      return ok(summary);
    }
    // A product never published carries no tag but `pending-publish` (data design 3.15 CHECKs).
    if (open.some((tag) => tag.status !== 'pending-publish')) {
      return err({ code: 'claim.inputs-changed' });
    }
    const types = requested.map((tag) => tag.typeCode);
    if (new Set(types).size !== types.length) return err({ code: 'tag.exists' });
    let verdicts = new Map<string, JudgedTag>();
    if (types.length > 0) {
      if (this.#state.handling === null) return err({ code: 'offer.handling-missing' });
      const judged = this.#judgeAll(input, types);
      if (!judged.ok) return judged;
      verdicts = judged.value;
    }
    const refused = types.flatMap((typeCode) => {
      const verdict = verdicts.get(typeCode)!.judgement;
      return verdict.kind === 'not-allowed' ? [{ typeCode, reason: verdict.reason }] : [];
    });
    if (refused.length > 0) return err({ code: 'claim.tag-not-allowed', tags: refused });
    for (const tag of open) {
      if (!types.includes(tag.typeCode)) {
        this.#removeTag(tag, 'revision-publish', input.actor, input.now);
      }
    }
    for (const { tagId, typeCode } of requested) {
      const verdict = verdicts.get(typeCode)!;
      const existing = open.find((tag) => tag.typeCode === typeCode);
      if (existing !== undefined) {
        this.#applyVerdict(existing, verdict, input, summary);
        continue;
      }
      const { judgement, inputsHash } = verdict;
      if (judgement.kind !== 'allowed') throw new Error('settlePublish: judged without a verdict');
      const tag: OfferTagState = {
        id: tagId,
        typeCode,
        status: 'active',
        copy: judgement.copy,
        badge: judgement.badge,
        copyRevisionId: input.facts.productRevisionId,
        copyRevisionPublished: true,
        inputsHash,
        lastReasonCode: 'allowed',
        lastChangeCause: input.entryPath,
        evaluatedAt: judgement.evaluatedAt,
        statusChangedAt: input.now,
        changeSeq: 1,
        removedAt: null,
        removedByKind: null,
        removedByAccountId: null,
        createdAt: input.now,
      };
      this.#putTag(tag, true);
      this.#historyOf(tag, null, input.entryPath, input.actor, input.now);
      this.#tagEvent(OfferTagAdded, tag, input.now);
      summary.kept += 1;
    }
    this.#refreshTagCause(input.now);
    if (this.#newTagIds.size > 0 || this.#changedTagIds.size > 0) this.#touch();
    return ok(summary);
  }

  /**
   * Rule M1 (Hassan; design 5.4): a write that changes a claim input of tags it does not settle in
   * the same unit (every PLATFORM publish, a published variant set change) marks them
   * `rechecking` in that unit, so no stale badge is shown until the fan-out asks again. Only an
   * `active` tag changes: its badge data goes (`rechecking` carries none, data design CHECK) and
   * the Offer stays listed (5.3). A `suspended` tag already shows no badge and stays `suspended`,
   * so the Offer stays off sale until a fresh allowed decision (AC 13); a `rechecking` tag stays
   * as it is; a `pending-publish` tag is not live. Answers how many tags changed.
   */
  markRechecking(input: {
    readonly entryPath: TagEntryPath;
    readonly actor: TagActor;
    readonly now: Temporal.Instant;
    /** Only these tags (a certification event's selection, design 5.5); all when absent. */
    readonly tagIds?: ReadonlySet<string>;
    readonly causeEventId?: Id | null;
  }): number {
    if (this.#state.status === 'deleted') return 0;
    let marked = 0;
    for (const tag of this.#tags) {
      if (tag.status !== 'active') continue;
      if (input.tagIds !== undefined && !input.tagIds.has(tag.id)) continue;
      const next: OfferTagState = {
        ...tag,
        status: 'rechecking',
        badge: null,
        lastChangeCause: input.entryPath,
        statusChangedAt: input.now,
        changeSeq: tag.changeSeq + 1,
      };
      this.#putTag(next, false);
      this.#historyOf(
        next,
        tag.status,
        input.entryPath,
        input.actor,
        input.now,
        input.causeEventId ?? null,
      );
      marked += 1;
    }
    if (marked > 0) this.#touch();
    return marked;
  }

  /**
   * Applies one tag's verdict (design 5.2, 5.3): allowed keeps or makes it `active` with the fresh
   * copy and badge; refused makes it `suspended` without badge data. One history row per change of
   * status or copy (data design 3.16; Mojtaba F1, Hassan M4) and the tag event of the change.
   */
  #applyVerdict(
    tag: OfferTagState,
    verdict: JudgedTag,
    input: ClaimAnswerInput,
    summary: { kept: number; suspended: number; restored: number; switched: number },
  ): void {
    const { judgement, inputsHash } = verdict;
    const facts = input.facts;
    if (judgement.kind === 'allowed') {
      // A tag that was effective (`active`, or `rechecking` after a handler marked it) and is
      // allowed again on another basis is a basis switch (design 5.3; AC 12).
      const switched =
        (tag.status === 'active' || tag.status === 'rechecking') &&
        tag.copy !== null &&
        tag.copy.basis !== judgement.copy.basis;
      const candidate: OfferTagState = {
        ...tag,
        inputsHash,
        copyRevisionId: facts.productRevisionId,
        copyRevisionPublished: true,
        evaluatedAt: judgement.evaluatedAt,
        status: 'active',
        copy: judgement.copy,
        badge: judgement.badge,
        lastReasonCode: 'allowed',
      };
      // A basis switch or a new certificate version is a change of its own (F1, M4).
      const changed = candidate.status !== tag.status || tagCopyKey(candidate) !== tagCopyKey(tag);
      const next: OfferTagState = changed
        ? {
            ...candidate,
            lastChangeCause: input.entryPath,
            statusChangedAt: input.now,
            changeSeq: tag.changeSeq + 1,
          }
        : candidate;
      this.#putTag(next, false);
      if (changed) {
        this.#historyOf(
          next,
          tag.status,
          input.entryPath,
          input.actor,
          input.now,
          input.causeEventId ?? null,
        );
      }
      if (tag.status === 'suspended') {
        this.#tagEvent(OfferTagRestored, next, input.now);
        summary.restored += 1;
      } else if (tag.status === 'pending-publish') {
        // The first time the badge is effective (5.1a point 3): announced as added.
        this.#tagEvent(OfferTagAdded, next, input.now);
        summary.kept += 1;
      } else if (switched) {
        this.#tagEvent(OfferTagBasisSwitched, next, input.now);
        summary.switched += 1;
      } else {
        summary.kept += 1;
      }
      return;
    }
    if (judgement.kind !== 'not-allowed') throw new Error('settle: judged without a verdict');
    const statusChange = tag.status !== 'suspended';
    // A refused tag keeps the copy of its last allowed decision. A `pending-publish` tag's copy
    // names the frozen revision this publish makes the published one, so it is a published copy
    // from now on (data design CHECK `offer_tags_published_copy_check`).
    const fromPending = tag.status === 'pending-publish';
    const next: OfferTagState = {
      ...tag,
      inputsHash,
      evaluatedAt: judgement.evaluatedAt,
      status: 'suspended',
      badge: null,
      lastReasonCode: judgement.reason,
      ...(fromPending
        ? { copyRevisionId: facts.productRevisionId, copyRevisionPublished: true }
        : {}),
      ...(statusChange ? { lastChangeCause: input.entryPath, statusChangedAt: input.now } : {}),
      changeSeq: statusChange ? tag.changeSeq + 1 : tag.changeSeq,
    };
    this.#putTag(next, false);
    if (statusChange) {
      this.#historyOf(
        next,
        tag.status,
        input.entryPath,
        input.actor,
        input.now,
        input.causeEventId ?? null,
      );
      this.#tagEvent(OfferTagSuspended, next, input.now);
    }
    summary.suspended += 1;
  }

  /**
   * The badge requests of a first submit of a never-published product (design 5.1a points 1, 2, 6;
   * `own-product.submit` with `requestedTags`). The facts name the frozen submitted revision, never
   * the working copy and never a published one. Every requested type must be allowed, else the
   * whole submit is refused (`claim.tag-not-allowed`); then the `pending-publish` tags become
   * exactly the requested set: a type left out is `removed`, a kept one takes the new copy, a new
   * one is written `pending-publish`. No badge data is stored and no event is written: the Offer
   * is not listed and only the publish re-ask can make such a tag `active` (point 3).
   */
  setPendingPublishTags(
    input: ClaimAnswerInput & {
      readonly tags: readonly { readonly tagId: Id<'OfferTag'>; readonly typeCode: string }[];
    },
  ): Result<void, OfferTagRefusal> {
    const state = this.#state;
    if (input.facts.revisionPublished) {
      throw new Error('setPendingPublishTags: the facts must name a frozen unpublished revision');
    }
    if (state.status === 'deleted') return err({ code: 'offer.not-taggable' });
    const open = this.#tags.filter((tag) => tag.status !== 'removed');
    // A product never published carries no tag but `pending-publish` (data design 3.15 CHECKs).
    if (open.some((tag) => tag.status !== 'pending-publish')) {
      return err({ code: 'claim.inputs-changed' });
    }
    const types = input.tags.map((tag) => tag.typeCode);
    if (new Set(types).size !== types.length) return err({ code: 'tag.exists' });
    let judged: Result<Map<string, JudgedTag>, OfferTagRefusal> = ok(new Map());
    if (types.length > 0) {
      if (state.handling === null) return err({ code: 'offer.handling-missing' });
      judged = this.#judgeAll(input, types);
    }
    if (!judged.ok) return judged;
    const verdicts = judged.value;
    const refused = types.flatMap((typeCode) => {
      const verdict = verdicts.get(typeCode)!.judgement;
      return verdict.kind === 'not-allowed' ? [{ typeCode, reason: verdict.reason }] : [];
    });
    if (refused.length > 0) return err({ code: 'claim.tag-not-allowed', tags: refused });
    for (const tag of open) {
      if (!types.includes(tag.typeCode)) {
        this.#removeTag(tag, 'revision-submit', input.actor, input.now);
      }
    }
    for (const { tagId, typeCode } of input.tags) {
      const { judgement, inputsHash } = verdicts.get(typeCode)!;
      if (judgement.kind !== 'allowed') throw new Error('setPendingPublishTags: no verdict');
      const existing = open.find((tag) => tag.typeCode === typeCode);
      const copy = {
        copy: judgement.copy,
        badge: null,
        copyRevisionId: input.facts.productRevisionId,
        copyRevisionPublished: false,
        inputsHash,
        lastReasonCode: 'allowed',
        evaluatedAt: judgement.evaluatedAt,
      };
      if (existing !== undefined) {
        const candidate: OfferTagState = { ...existing, ...copy };
        if (tagCopyKey(candidate) === tagCopyKey(existing)) {
          this.#putTag(candidate, false);
          continue;
        }
        // A new frozen revision or certificate is a copy change: its own history row (F1, M4).
        const next: OfferTagState = {
          ...candidate,
          lastChangeCause: 'revision-submit',
          statusChangedAt: input.now,
          changeSeq: existing.changeSeq + 1,
        };
        this.#putTag(next, false);
        this.#historyOf(next, existing.status, 'revision-submit', input.actor, input.now);
        continue;
      }
      const tag: OfferTagState = {
        id: tagId,
        typeCode,
        status: 'pending-publish',
        ...copy,
        lastChangeCause: 'revision-submit',
        statusChangedAt: input.now,
        changeSeq: 1,
        removedAt: null,
        removedByKind: null,
        removedByAccountId: null,
        createdAt: input.now,
      };
      this.#putTag(tag, true);
      this.#historyOf(tag, null, 'revision-submit', input.actor, input.now);
    }
    if (this.#newTagIds.size > 0 || this.#changedTagIds.size > 0) this.#touch();
    return ok(undefined);
  }

  /**
   * The seller removes an `active` tag (`own-offer.remove-tag`, design 5.3). A `suspended` tag is
   * removed only with the "sell without this badge" confirmation of its own command (slice 12):
   * `tag.suspended`. A `pending-publish` tag is left out at the next submit instead.
   */
  removeTag(input: {
    readonly typeCode: string;
    readonly actor: TagActor;
    readonly now: Temporal.Instant;
  }): Result<void, OfferTagRefusal> {
    if (this.#state.status === 'deleted') return err({ code: 'offer.not-taggable' });
    const tag = this.#openTag(input.typeCode);
    if (tag === undefined) return err({ code: 'tag.not-found' });
    if (tag.status === 'suspended') return err({ code: 'tag.suspended' });
    if (tag.status !== 'active') return err({ code: 'tag.not-removable' });
    const removed = this.#removeTag(tag, 'seller-remove', input.actor, input.now);
    this.#tagEvent(OfferTagRemoved, removed, input.now);
    this.#touch();
    return ok(undefined);
  }

  /**
   * "Sell without this badge" (design 5.3 `suspended` → `removed`; brief s7): the seller removes a
   * `suspended` tag with an explicit confirmation, which the use case requires. Removing only
   * restricts, so nothing is asked. The cause `tag-suspended` goes when no other tag is suspended
   * and the Offer is listed again without the badge. Any other status is refused: an `active` tag
   * has its own removal, and a `rechecking` one waits for its answer (`tag.not-suspended`).
   */
  removeSuspendedTag(input: {
    readonly typeCode: string;
    readonly actor: TagActor;
    readonly now: Temporal.Instant;
  }): Result<void, OfferTagRefusal> {
    if (this.#state.status === 'deleted') return err({ code: 'offer.not-taggable' });
    const tag = this.#openTag(input.typeCode);
    if (tag === undefined) return err({ code: 'tag.not-found' });
    if (tag.status !== 'suspended') return err({ code: 'tag.not-suspended' });
    const removed = this.#removeTag(tag, 'seller-remove-suspended', input.actor, input.now);
    this.#tagEvent(OfferTagRemoved, removed, input.now);
    this.#refreshTagCause(input.now);
    this.#touch();
    return ok(undefined);
  }

  /** The tag of the type that is not removed (at most one per type), if any. */
  #openTag(typeCode: string): OfferTagState | undefined {
    return this.#tags.find((tag) => tag.typeCode === typeCode && tag.status !== 'removed');
  }

  /**
   * Judges every type against queries rebuilt from this Offer's own state (design 8.3: the domain
   * refuses a decision whose inputs differ from its own state). A stale answer for any type
   * refuses all; then an unavailable one refuses all.
   */
  #judgeAll(
    input: ClaimAnswerInput,
    types: readonly string[],
  ): Result<Map<string, JudgedTag>, OfferTagRefusal> {
    const out = new Map<string, JudgedTag>();
    let unavailable = false;
    for (const typeCode of types) {
      const expected = claimQueriesFor(this.#state, input.facts, typeCode);
      if (expected === null) return err({ code: 'offer.handling-missing' });
      const judgement = judgeTag(expected, input.decisions.get(typeCode));
      if (judgement.kind === 'stale') return err({ code: 'claim.inputs-changed' });
      if (judgement.kind === 'unavailable') unavailable = true;
      out.set(typeCode, {
        judgement,
        inputsHash: expected.length > 0 ? input.hash(canonicalClaimInputs(expected)) : null,
      });
    }
    if (unavailable) return err({ code: 'claim.check-unavailable' });
    return ok(out);
  }

  #removeTag(
    tag: OfferTagState,
    entryPath: TagEntryPath,
    actor: TagActor,
    now: Temporal.Instant,
  ): OfferTagState {
    const removed: OfferTagState = {
      ...tag,
      status: 'removed',
      badge: null,
      lastChangeCause: entryPath,
      statusChangedAt: now,
      changeSeq: tag.changeSeq + 1,
      removedAt: now,
      removedByKind: actor.kind === 'seller' ? 'seller' : 'system',
      removedByAccountId: actor.kind === 'seller' ? actor.accountId : null,
    };
    this.#putTag(removed, false);
    this.#historyOf(removed, tag.status, entryPath, actor, now);
    return removed;
  }

  /**
   * Stores a tag change in the aggregate. One change of status or copy per tag per unit (Mojtaba,
   * slice 8 follow-up): the database raises `change_seq` by exactly one per row update and the
   * repository's update is conditional on the value read, so a second change of the same tag in
   * one unit is a defect and throws here instead of failing at commit. A new tag is inserted at
   * `change_seq` 1 and cannot change again in its unit.
   */
  #putTag(tag: OfferTagState, isNew: boolean): void {
    const frozen = Object.freeze({ ...tag });
    const index = this.#tags.findIndex((existing) => existing.id === tag.id);
    const base = isNew || this.#newTagIds.has(tag.id) ? 0 : this.#readChangeSeqs.get(tag.id);
    if (base === undefined || tag.changeSeq < Math.max(base, 1) || tag.changeSeq > base + 1) {
      throw new Error('putTag: more than one change of a tag in one unit');
    }
    if (isNew) {
      if (index !== -1) throw new Error('putTag: the tag id is taken');
      this.#tags.push(frozen);
      this.#newTagIds.add(tag.id);
      return;
    }
    if (index === -1) throw new Error('putTag: unknown tag');
    this.#tags[index] = frozen;
    if (!this.#newTagIds.has(tag.id)) this.#changedTagIds.add(tag.id);
  }

  #historyOf(
    tag: OfferTagState,
    fromStatus: OfferTagStatus | null,
    entryPath: TagEntryPath,
    actor: TagActor,
    now: Temporal.Instant,
    causeEventId: Id | null = null,
  ): void {
    this.#tagHistory.push({
      tagId: tag.id,
      typeCode: tag.typeCode,
      fromStatus,
      toStatus: tag.status,
      changeSeq: tag.changeSeq,
      copy: tag.copy,
      copyRevisionId: tag.copyRevisionId,
      reasonCode: tag.lastReasonCode,
      entryPath,
      actor,
      causeEventId,
      occurredAt: now,
    });
  }

  /** The cause `tag-suspended` is present exactly while a tag is suspended (design 4.4, 5.3). */
  #refreshTagCause(now: Temporal.Instant): void {
    const state = this.#state;
    const suspended = this.#tags.some((tag) => tag.status === 'suspended');
    if (suspended === state.offSaleCauses.includes('tag-suspended')) return;
    const causes = OFF_SALE_CAUSES.filter((cause) =>
      cause === 'tag-suspended' ? suspended : state.offSaleCauses.includes(cause),
    );
    const listed = isListed({ status: state.status, offSaleCauses: causes });
    this.#state = Object.freeze({ ...state, offSaleCauses: causes, listed });
    if (this.#pendingHistory === null) {
      this.#pendingHistory = { changeKind: 'causes-changed', changedFields: [], occurredAt: now };
    }
    if (listed !== state.listed) {
      const version = this.#nextEventVersion();
      this.#events.push(
        OfferListingChanged.record({
          aggregateId: state.id,
          aggregateVersion: version,
          occurredAt: now,
          payload: { offerId: state.id, listed },
        }),
      );
    }
  }

  #tagEvent(
    definition:
      | typeof OfferTagAdded
      | typeof OfferTagRemoved
      | typeof OfferTagSuspended
      | typeof OfferTagRestored
      | typeof OfferTagBasisSwitched,
    tag: OfferTagState,
    now: Temporal.Instant,
  ): void {
    const version = this.#nextEventVersion();
    this.#events.push(
      definition.record({
        aggregateId: this.#state.id,
        aggregateVersion: version,
        occurredAt: now,
        payload: {
          offerId: this.#state.id,
          tagId: tag.id,
          basis: tag.copy === null ? null : tag.copy.basis === 'SELLER' ? 'seller' : 'manufacturer',
        },
      }),
    );
  }

  /**
   * The version the next event carries, raising the Offer's version to it (Q-K3: the n-th new
   * event since the read carries the read version plus n; a change with no event raises it by one).
   */
  #nextEventVersion(): number {
    const base = this.#persistedVersion ?? 0;
    const version = Math.max(this.#state.version, base + this.#events.length + 1);
    this.#state = Object.freeze({ ...this.#state, version });
    return version;
  }

  /** A change with no event of its own still raises the version once (P 10). */
  #touch(): void {
    if (this.#persistedVersion !== null && this.#state.version === this.#persistedVersion) {
      this.#state = Object.freeze({ ...this.#state, version: this.#state.version + 1 });
    }
  }

  /** `published` with its first-publication stamp and the event; listed when no cause is stored. */
  #publish(
    now: Temporal.Instant,
    changeKind: 'published' | 'publication-approved',
    extra: { readonly submittedAt?: Temporal.Instant },
  ): void {
    // The next event's version: a tag settle of the same unit that only touched the Offer has
    // already raised it once, and the publication is its first event (Q-K3).
    const version = this.#nextEventVersion();
    const state = this.#state;
    this.#state = Object.freeze({
      ...state,
      ...extra,
      status: 'published',
      firstPublishedAt: now,
      listed: isListed({ status: 'published', offSaleCauses: state.offSaleCauses }),
      version,
    });
    this.#pendingHistory = { changeKind, changedFields: [], occurredAt: now };
    this.#events.push(
      OfferPublished.record({
        aggregateId: state.id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { offerId: state.id, productId: state.productId, sellerId: state.sellerId },
      }),
    );
  }

  #assertNoChange(command: string): void {
    if (this.#pendingHistory !== null)
      throw new Error(`${command}: the Offer already has a change`);
  }

  /** An Offer read back from storage, with its tags; records no event. */
  /**
   * An Offer read back from storage with its open tags. Without `tags` it is a read-only
   * projection (a list or queue row): saving it throws (I1), so a write never drops its tags.
   */
  static restore(state: OfferState, tags?: readonly OfferTagState[]): Offer {
    return new Offer(state, state.version, tags ?? null);
  }

  /** False for a read-only projection restored without its tags (never saved). */
  get tagsLoaded(): boolean {
    return this.#tagsLoaded;
  }

  /** The `change_seq` a stored tag had when it was read; its update is conditional on it (F2). */
  readChangeSeqOf(tagId: string): number | undefined {
    return this.#readChangeSeqs.get(tagId);
  }

  /** The tags, removed ones included, in their stored order. */
  get tags(): readonly OfferTagState[] {
    return [...this.#tags];
  }

  /** The ids of the tags to insert and to update at the next save. */
  get pendingTagChanges(): {
    readonly added: readonly string[];
    readonly changed: readonly string[];
  } {
    return { added: [...this.#newTagIds], changed: [...this.#changedTagIds] };
  }

  /** The tag history rows to store with the change, in order. */
  get pendingTagHistory(): readonly OfferTagPendingHistory[] {
    return [...this.#tagHistory];
  }

  /** True when anything has changed since the read (the root, a tag, or an event). */
  get hasChanges(): boolean {
    return (
      this.#pendingHistory !== null ||
      this.#newTagIds.size > 0 ||
      this.#changedTagIds.size > 0 ||
      this.#state.version !== this.#persistedVersion
    );
  }

  get state(): OfferState {
    return this.#state;
  }

  /** The version the row had when it was read, or null for an Offer not yet stored. */
  get persistedVersion(): number | null {
    return this.#persistedVersion;
  }

  /** The history row to store with the change made since the Offer was read, or null. */
  get pendingHistory(): OfferPendingHistory | null {
    return this.#pendingHistory;
  }

  /** Events recorded since the aggregate was built, in the order of their versions. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }
}
