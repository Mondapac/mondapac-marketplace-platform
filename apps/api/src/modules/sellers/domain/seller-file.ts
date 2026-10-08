import type { Id, MarketId, PendingEvent, Temporal } from '@mondapac/shared-kernel';
import { SellerFileCreated } from './events';

/** The origins of a seller file (data design 3.1), as `identity` publishes them. */
export const SELLER_FILE_ORIGINS = ['self', 'invitation'] as const;
export type SellerFileOrigin = (typeof SELLER_FILE_ORIGINS)[number];

export interface SellerFileState {
  readonly sellerId: Id<'Seller'>;
  readonly marketId: MarketId;
  readonly origin: SellerFileOrigin;
  /** The Market policy read in the creating unit (design 7.5); the stricter wins later (AC 19). */
  readonly approvalRequiredAtRegistration: boolean;
  /** False at creation; the later slices write it on every save. */
  readonly draftComplete: boolean;
  /** Equals `createdAt` at creation. */
  readonly lastChangedAt: Temporal.Instant;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
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
 * decision 1). Slice 1 holds what creation needs; the draft, the revisions and the pointers
 * arrive with later slices. The admin settings, the tax profile and the store profile are
 * created with it, in the same unit, from the defaults above.
 */
export class SellerFile {
  readonly #state: SellerFileState;
  readonly #events: PendingEvent[] = [];

  private constructor(state: SellerFileState) {
    this.#state = Object.freeze(state);
  }

  static create(input: {
    readonly sellerId: Id<'Seller'>;
    readonly marketId: MarketId;
    readonly origin: SellerFileOrigin;
    readonly approvalRequiredAtRegistration: boolean;
    readonly now: Temporal.Instant;
  }): SellerFile {
    const file = new SellerFile({
      sellerId: input.sellerId,
      marketId: input.marketId,
      origin: input.origin,
      approvalRequiredAtRegistration: input.approvalRequiredAtRegistration,
      draftComplete: false,
      lastChangedAt: input.now,
      version: 1,
      createdAt: input.now,
    });
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

  get state(): SellerFileState {
    return this.#state;
  }

  /** Events recorded since the aggregate was built. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }
}
