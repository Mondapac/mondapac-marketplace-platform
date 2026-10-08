import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result, Temporal } from '@mondapac/shared-kernel';
import { SellerFileCreated } from './events';
import type { Sealed } from './sealed';
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

/** A save refused by the aggregate. Codes only (sellers design 8.3). */
export type DraftRefused =
  | { readonly code: 'file.change-request-required' }
  | { readonly code: 'phone.required' }
  | { readonly code: 'timezone.not-selectable' };

/** The mandatory parts of a complete draft (brief AC 5), in the order of the form. */
export const DRAFT_PARTS = ['storeName', 'businessName', 'phone', 'address', 'timezone'] as const;
export type DraftPart = (typeof DRAFT_PARTS)[number];

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

  /** Whether the draft may change: not once the file has an approved revision (D 3.1). */
  get draftEditable(): boolean {
    return !this.#state.hasApprovedRevision;
  }

  /** The mandatory parts the draft does not hold yet, in the order of the form. */
  missing(): readonly DraftPart[] {
    return missingParts(this.#state.draft);
  }

  /** Saves the General group (store name, business name, phone, contact email). */
  saveGeneral(input: GeneralDraftInput, now: Temporal.Instant): Result<void, DraftRefused> {
    if (this.#state.hasApprovedRevision) return err({ code: 'file.change-request-required' });
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
    );
    return ok(undefined);
  }

  /**
   * Saves the Address group: the operating address, the registered address when it differs,
   * the ServiceArea code the operating postcode fell in, and the zone (`zoneAfterAddressSave`).
   * An address outside every area is still saved (brief s7: the seller learns at once).
   */
  saveAddress(input: AddressDraftInput, now: Temporal.Instant): Result<void, DraftRefused> {
    if (this.#state.hasApprovedRevision) return err({ code: 'file.change-request-required' });
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
    );
    return ok(undefined);
  }

  private apply(draft: SellerFileDraft, now: Temporal.Instant): void {
    this.#state = Object.freeze({
      ...this.#state,
      draft: Object.freeze(draft),
      draftComplete: missingParts(draft).length === 0,
      lastChangedAt: now,
      version: this.#state.version + 1,
    });
  }
}

function missingParts(draft: SellerFileDraft): readonly DraftPart[] {
  const present: Record<DraftPart, boolean> = {
    storeName: draft.storeName !== null,
    businessName: draft.businessName !== null,
    phone: draft.phone !== null,
    address: draft.address !== null,
    timezone: draft.zone !== null,
  };
  return DRAFT_PARTS.filter((part) => !present[part]);
}
