import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result, Temporal } from '@mondapac/shared-kernel';
import { sameIdentifier, type DraftIdentifier } from './business-identifier';
import {
  REVISION_AUTHOR_KINDS,
  REVISION_KINDS,
  WITHDRAW_CAUSES,
  type RevisionAuthorKind,
  type RevisionKind,
  type WithdrawCause,
} from './revision-kinds';
import type { DecisionIntent } from './decision-intent';
import { BusinessFileSubmitted, BusinessFileWithdrawn, SellerFileCreated } from './events';
import type { Sealed } from './sealed';
import type { ShopSlug } from './shop-slug';
import type { StoreName } from './store-name';
import { zoneAfterAddressSave, type RegionZones, type ZoneChoice, type ZoneState } from './zone';

/** The origins of a seller file (data design 3.1), as `identity` publishes them. */
export const SELLER_FILE_ORIGINS = ['self', 'invitation'] as const;
export type SellerFileOrigin = (typeof SELLER_FILE_ORIGINS)[number];

/**
 * The working draft (sellers design 2.1; data design 3.1). The store name is clear (public once
 * approved); every other personal field is held only as ciphertext under the seller's key
 * (design 8.1), sealed before it reaches the aggregate. Null means "not entered".
 */
export interface SellerFileDraft {
  readonly storeName: StoreName | null;
  readonly businessName: Sealed<'business-name'> | null;
  readonly phone: Sealed<'phone'> | null;
  readonly contactEmail: Sealed<'contact-email'> | null;
  /** The operating address: the only one that drives the ServiceArea and the zones. */
  readonly address: Sealed<'address'> | null;
  /** The registered address when it differs; null means "same as the operating address". */
  readonly registeredAddress: Sealed<'registered-address'> | null;
  /** The ServiceArea the operating address fell in at its last save, or null for none. */
  readonly serviceAreaCode: string | null;
  readonly zone: ZoneState | null;
  /** The shop slug the seller chose (Q-M25): parsed, not held; the first submission holds it. */
  readonly slug: ShopSlug | null;
  /** The business identifier: scheme (clear), sealed normalised value and its keyed index. */
  readonly identifier: DraftIdentifier | null;
}

export const EMPTY_DRAFT: SellerFileDraft = Object.freeze({
  storeName: null,
  businessName: null,
  phone: null,
  contactEmail: null,
  address: null,
  registeredAddress: null,
  serviceAreaCode: null,
  zone: null,
  slug: null,
  identifier: null,
});

export interface SellerFileState {
  readonly sellerId: Id<'Seller'>;
  readonly marketId: MarketId;
  readonly origin: SellerFileOrigin;
  /** The Market policy read in the creating unit (design 7.5); the stricter wins later (AC 19). */
  readonly approvalRequiredAtRegistration: boolean;
  /** Recomputed from the draft on every save (data design 3.1): the "Incomplete" tab only. */
  readonly draftComplete: boolean;
  /** Every change of the file; equals `createdAt` at creation. */
  readonly lastChangedAt: Temporal.Instant;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  /**
   * Whether the file has an approved revision (data design 3.1 `approved_revision_id IS NOT
   * NULL`): what makes a file "approved" for the draft. `identity`'s access state plays no part
   * (a seller `identity` reports approved with no approved revision is `file-check-needed`, D 3.3,
   * and must still complete the details). Always false until slice 5, which adds the revisions
   * and the pointer; the repository then reads it from `approved_revision_id`.
   */
  readonly hasApprovedRevision: boolean;
  /**
   * The decision in flight around a call into `identity` (design 3.2; slice 7a-decide), or null.
   * While it is set the draft does not change and the pending revision cannot be withdrawn.
   */
  readonly decisionIntent: DecisionIntent | null;
  readonly draft: SellerFileDraft;
}

/** The General group of a save: the whole group, so an absent optional field is cleared. */
export interface GeneralDraftInput {
  readonly storeName: StoreName | null;
  readonly businessName: Sealed<'business-name'> | null;
  readonly phone: Sealed<'phone'> | null;
  readonly contactEmail: Sealed<'contact-email'> | null;
}

/** The Address group of a save, with what the use case resolved from configuration for it. */
export interface AddressDraftInput {
  readonly address: Sealed<'address'>;
  readonly registeredAddress: Sealed<'registered-address'> | null;
  /** From `ServiceAreaDirectory.areaFor` on the operating postcode, or null for none. */
  readonly serviceAreaCode: string | null;
  /** The zones of the operating address's region (Market configuration), or null for none. */
  readonly zones: RegionZones | null;
  readonly zone: ZoneChoice;
}

/** What a submission tells the file about its new revision (sellers design 7.4). */
export interface SubmissionRecord {
  readonly revisionId: Id<'BusinessFileRevision'>;
  readonly kind: RevisionKind;
  readonly authorKind: RevisionAuthorKind;
  /** The file had an earlier revision: another try, not a first application. */
  readonly resubmission: boolean;
}

/** What a withdrawal tells the file about the revision it closed (sellers design 7.4). */
export interface WithdrawalRecord {
  readonly revisionId: Id<'BusinessFileRevision'>;
  readonly cause: WithdrawCause;
  readonly byKind: RevisionAuthorKind;
}

/**
 * A decision on the pending revision is in flight (design 3.2): the revision is locked until its
 * second unit, the event handler or the reconciliation job ends the intent.
 */
export type DecisionLocked = { readonly code: 'file.decision-in-progress' };

/** Why the draft is frozen: an approved revision, or a decision in flight. */
export type DraftFrozen = { readonly code: 'file.change-request-required' } | DecisionLocked;

/** A save refused by the aggregate. Codes only (sellers design 8.3). */
export type DraftRefused =
  DraftFrozen | { readonly code: 'phone.required' } | { readonly code: 'timezone.not-selectable' };

/**
 * The parts of a complete draft (brief AC 5), in the order of the form: details, address, number,
 * slug. The identifier is a part only when the Market requires it (design 3.1, Q3).
 */
export const DRAFT_PARTS = [
  'storeName',
  'businessName',
  'phone',
  'address',
  'timezone',
  'identifier',
  'slug',
] as const;
export type DraftPart = (typeof DRAFT_PARTS)[number];

/**
 * What the Market's current configuration asks of a draft (design 3.1, 4.1). Every save and
 * every reading of the missing parts takes it explicitly: there is no default, so a Market that
 * requires an identifier is never judged by another Market's rule.
 */
export interface DraftRequirements {
  readonly identifierRequired: boolean;
  /**
   * The Market's current scheme code. A stored identifier of another scheme (the Market changed
   * its scheme after the seller saved) does not count: it is not valid for this Market (AC 3).
   */
  readonly identifierScheme: string;
}

/**
 * The defaults the creating handler writes into the seller's admin settings (sellers design
 * 7.5; data design 3.9): every product type allowed, category proposals off, AI off. They are
 * written, never column defaults, so a missing row is a fault and never silently a default.
 */
export const NEW_SELLER_ADMIN_SETTINGS = Object.freeze({
  allProductTypesAllowed: true,
  categoryProposalsAllowed: false,
  aiEnabled: false,
});

/**
 * The file of one seller (sellers design 2.1), under the id `identity` minted (ADR-0022
 * decision 1). Slice 1 creates it with its admin settings, tax profile and store profile; slice 2
 * adds the working draft. The revisions and pointers arrive with later slices.
 *
 * Draft invariants held here, whatever the entry point (design 3.1, 6.2, 6.3):
 * - a save on a file with an approved revision is refused with `file.change-request-required`
 *   (D 3.1, Hassan L2; data design 3.1): business identity then changes only through a change
 *   request. `identity`'s access state never freezes the draft; until slice 5 no file has an
 *   approved revision, so nothing is frozen yet;
 * - the General group is never saved without a phone (SEL-11, AC 7);
 * - saving the slug the draft already has is a no-op (no version change);
 * - a chosen zone is on its region's list (`zoneAfterAddressSave`);
 * - every save recomputes `draftComplete`, stamps `lastChangedAt` and raises the version by one;
 *   the repository writes it only over the version it read (optimistic, P 10).
 */
export class SellerFile {
  #state: SellerFileState;
  readonly #persistedVersion: number;
  readonly #events: PendingEvent[] = [];

  private constructor(state: SellerFileState, persistedVersion: number) {
    this.#state = Object.freeze(state);
    this.#persistedVersion = persistedVersion;
  }

  static create(input: {
    readonly sellerId: Id<'Seller'>;
    readonly marketId: MarketId;
    readonly origin: SellerFileOrigin;
    readonly approvalRequiredAtRegistration: boolean;
    readonly now: Temporal.Instant;
  }): SellerFile {
    const file = new SellerFile(
      {
        sellerId: input.sellerId,
        marketId: input.marketId,
        origin: input.origin,
        approvalRequiredAtRegistration: input.approvalRequiredAtRegistration,
        draftComplete: false,
        lastChangedAt: input.now,
        version: 1,
        createdAt: input.now,
        hasApprovedRevision: false,
        decisionIntent: null,
        draft: EMPTY_DRAFT,
      },
      1,
    );
    file.#events.push(
      SellerFileCreated.record({
        aggregateId: input.sellerId,
        aggregateVersion: 1,
        occurredAt: input.now,
        payload: { sellerId: input.sellerId },
      }),
    );
    return file;
  }

  /** A stored file, as the repository read it; its version is the one a save must find. */
  static restore(state: SellerFileState): SellerFile {
    return new SellerFile({ ...state, draft: Object.freeze({ ...state.draft }) }, state.version);
  }

  get state(): SellerFileState {
    return this.#state;
  }

  /** The version the file had when it was read: the repository writes only over it. */
  get persistedVersion(): number {
    return this.#persistedVersion;
  }

  /** Events recorded since the aggregate was built. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  /**
   * Whether the draft may change: not once the file has an approved revision (D 3.1), and not
   * while a decision is in flight (D 3.2).
   */
  get draftEditable(): boolean {
    return this.frozen() === null;
  }

  /** Why the draft may not change now, or null when it may. */
  frozen(): DraftFrozen | null {
    if (this.#state.hasApprovedRevision) return { code: 'file.change-request-required' };
    if (this.#state.decisionIntent !== null) return { code: 'file.decision-in-progress' };
    return null;
  }

  /** The mandatory parts the draft does not hold yet, in the order of the form. */
  missing(requirements: DraftRequirements): readonly DraftPart[] {
    return missingParts(this.#state.draft, requirements);
  }

  /** Saves the General group (store name, business name, phone, contact email). */
  saveGeneral(
    input: GeneralDraftInput,
    now: Temporal.Instant,
    requirements: DraftRequirements,
  ): Result<void, DraftRefused> {
    const frozen = this.frozen();
    if (frozen !== null) return err(frozen);
    if (input.phone === null) return err({ code: 'phone.required' });
    this.apply(
      {
        ...this.#state.draft,
        storeName: input.storeName,
        businessName: input.businessName,
        phone: input.phone,
        contactEmail: input.contactEmail,
      },
      now,
      requirements,
    );
    return ok(undefined);
  }

  /**
   * Saves the Address group: the operating address, the registered address when it differs,
   * the ServiceArea code the operating postcode fell in, and the zone (`zoneAfterAddressSave`).
   * An address outside every area is still saved (brief s7: the seller learns at once).
   */
  saveAddress(
    input: AddressDraftInput,
    now: Temporal.Instant,
    requirements: DraftRequirements,
  ): Result<void, DraftRefused> {
    const frozen = this.frozen();
    if (frozen !== null) return err(frozen);
    const zone = zoneAfterAddressSave(this.#state.draft.zone, input.zones, input.zone);
    if (!zone.ok) return zone;
    this.apply(
      {
        ...this.#state.draft,
        address: input.address,
        registeredAddress: input.registeredAddress,
        serviceAreaCode: input.serviceAreaCode,
        zone: zone.value,
      },
      now,
      requirements,
    );
    return ok(undefined);
  }

  /**
   * Saves the chosen shop slug (Q-M25). The slug is already parsed against the Market's reserved
   * words and checked for availability by the use case; it is not held here. Saving the slug the
   * draft already has changes nothing (no version bump).
   */
  saveSlug(
    slug: ShopSlug,
    now: Temporal.Instant,
    requirements: DraftRequirements,
  ): Result<void, DraftFrozen> {
    const frozen = this.frozen();
    if (frozen !== null) return err(frozen);
    if (this.#state.draft.slug === slug) return ok(undefined);
    this.apply({ ...this.#state.draft, slug }, now, requirements);
    return ok(undefined);
  }

  /**
   * Saves the business identifier (design 3.1, 4.2; slice 3), already parsed against the Market's
   * scheme by the use case: the draft keeps the scheme code, the sealed normalised value and its
   * keyed index, all three or none (the database CHECK repeats it). `null` clears it, which is
   * only complete again for a Market that does not require one. Saving the value the draft
   * already holds, of the same scheme, changes nothing (no version bump, the old ciphertext stays).
   */
  saveIdentifier(
    identifier: DraftIdentifier | null,
    now: Temporal.Instant,
    requirements: DraftRequirements,
  ): Result<void, DraftFrozen> {
    const frozen = this.frozen();
    if (frozen !== null) return err(frozen);
    if (sameIdentifier(this.#state.draft.identifier, identifier)) return ok(undefined);
    this.apply({ ...this.#state.draft, identifier }, now, requirements);
    return ok(undefined);
  }

  /**
   * Records that a revision was created from the draft (sellers design 3.1, 7.4; slice 5b). The
   * submission changes no draft column: it raises the file's version (the repository writes it
   * over the version read, so a save, a withdrawal or another submission that committed first
   * makes this one lose) and appends `sellers.business-file-submitted.v1` at that version. An
   * onboarding submission on a file with an approved revision is refused: that file changes
   * business identity through a change request only.
   */
  recordSubmission(
    input: SubmissionRecord,
    now: Temporal.Instant,
  ): Result<void, { readonly code: 'file.change-request-required' }> {
    if (!(REVISION_KINDS as readonly string[]).includes(input.kind)) {
      throw new TypeError('recordSubmission: unknown kind');
    }
    if (!(REVISION_AUTHOR_KINDS as readonly string[]).includes(input.authorKind)) {
      throw new TypeError('recordSubmission: unknown author kind');
    }
    if (input.kind === 'onboarding' && this.#state.hasApprovedRevision) {
      return err({ code: 'file.change-request-required' });
    }
    this.touch(now);
    this.#events.push(
      BusinessFileSubmitted.record({
        aggregateId: this.#state.sellerId,
        aggregateVersion: this.#state.version,
        occurredAt: now,
        payload: {
          sellerId: this.#state.sellerId,
          revisionId: input.revisionId,
          kind: input.kind,
          authorKind: input.authorKind,
          resubmission: input.resubmission,
        },
      }),
    );
    return ok(undefined);
  }

  /**
   * Records that the pending revision was withdrawn (design 3.1, 7.4; slice 5b), after a draft
   * edit (the save already raised the version in this unit, and the event reuses it) or on its
   * own (the version is raised here). The revision's status is the revision repository's.
   */
  recordWithdrawal(input: WithdrawalRecord, now: Temporal.Instant): void {
    if (!(WITHDRAW_CAUSES as readonly string[]).includes(input.cause)) {
      throw new TypeError('recordWithdrawal: unknown cause');
    }
    if (!(REVISION_AUTHOR_KINDS as readonly string[]).includes(input.byKind)) {
      throw new TypeError('recordWithdrawal: unknown actor kind');
    }
    this.touch(now);
    this.#events.push(
      BusinessFileWithdrawn.record({
        aggregateId: this.#state.sellerId,
        aggregateVersion: this.#state.version,
        occurredAt: now,
        payload: {
          sellerId: this.#state.sellerId,
          revisionId: input.revisionId,
          cause: input.cause,
          byKind: input.byKind,
        },
      }),
    );
  }

  /**
   * Sets the decision intent (design 3.2; unit 1 of 7.3): from here the revision it names is
   * locked. Refused while another intent is set, or when the file already has an approved
   * revision and the intent is about onboarding (only one onboarding approval per file).
   */
  beginDecision(intent: DecisionIntent): Result<void, DecisionLocked | DraftFrozen> {
    if (this.#state.decisionIntent !== null) return err({ code: 'file.decision-in-progress' });
    if (this.#state.hasApprovedRevision) return err({ code: 'file.change-request-required' });
    this.touch(intent.since);
    this.#state = Object.freeze({ ...this.#state, decisionIntent: intent });
    return ok(undefined);
  }

  /**
   * Closes a decision step on this revision (unit 2 of 7.3, the event handler or the
   * reconciliation job; data design 3.1: a decision closure is a change of the file): raises the
   * version once per unit and ends the intent when it names this revision. Answers whether an
   * intent ended.
   */
  closeDecision(revisionId: Id<'BusinessFileRevision'>, now: Temporal.Instant): boolean {
    this.touch(now);
    if (this.#state.decisionIntent?.revisionId !== revisionId) return false;
    this.#state = Object.freeze({ ...this.#state, decisionIntent: null });
    return true;
  }

  /**
   * Records that the onboarding revision was approved (design 3.1, 7.3): the file now has an
   * approved revision, so its draft is frozen, and an intent naming the revision ends. The
   * pointer itself (`approved_revision_id`) and the public store name are written by the
   * repository in the same unit as the revision's status (data design 22, open point 2).
   */
  recordApproval(
    revisionId: Id<'BusinessFileRevision'>,
    now: Temporal.Instant,
  ): Result<void, { readonly code: 'file.change-request-required' }> {
    if (this.#state.hasApprovedRevision) return err({ code: 'file.change-request-required' });
    this.closeDecision(revisionId, now);
    this.#state = Object.freeze({ ...this.#state, hasApprovedRevision: true });
    return ok(undefined);
  }

  /**
   * The file changed in this unit without its draft changing: raises the version and stamps the
   * change, once per unit (an edit that already raised it keeps its version).
   */
  private touch(now: Temporal.Instant): void {
    if (this.#state.version !== this.#persistedVersion) return;
    this.#state = Object.freeze({
      ...this.#state,
      lastChangedAt: now,
      version: this.#state.version + 1,
    });
  }

  private apply(
    draft: SellerFileDraft,
    now: Temporal.Instant,
    requirements: DraftRequirements,
  ): void {
    this.#state = Object.freeze({
      ...this.#state,
      draft: Object.freeze(draft),
      draftComplete: missingParts(draft, requirements).length === 0,
      lastChangedAt: now,
      version: this.#state.version + 1,
    });
  }
}

/** The mandatory parts a draft does not hold, in form order (also the submission's check). */
export function missingParts(
  draft: SellerFileDraft,
  requirements: DraftRequirements,
): readonly DraftPart[] {
  const present: Record<DraftPart, boolean> = {
    storeName: draft.storeName !== null,
    businessName: draft.businessName !== null,
    phone: draft.phone !== null,
    address: draft.address !== null,
    timezone: draft.zone !== null,
    identifier:
      !requirements.identifierRequired ||
      draft.identifier?.scheme === requirements.identifierScheme,
    slug: draft.slug !== null,
  };
  return DRAFT_PARTS.filter((part) => !present[part]);
}
