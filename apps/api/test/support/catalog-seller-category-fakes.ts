import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  NewCategoryProposal,
  NewShelf,
  ProposalDecision,
  SellerCategoryStore,
  ShelfActor,
} from '../../src/modules/catalog/application/ports/seller-category.store';
import type {
  CategoryProposalView,
  ProposalCancelReason,
  ShelfView,
} from '../../src/modules/catalog/domain/seller-category';

// An in-memory seller category store (categories C9a) for the use-case specs. It keeps the rules
// of the SQL one: the pending unique (seller, parent, normalised name), the guarded decisions
// from `pending` at the version read, a shelf closing only from `active`. The SQL store is proved
// in test/db/catalog-seller-categories.db-spec.ts.

export interface MemoryOffer {
  readonly id: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  shelfId: Id<'SellerCategory'> | null;
  version: number;
  deleted: boolean;
}

export interface MemoryHistory {
  readonly offerId: string;
  readonly kind: 'shelf-cleared' | 'edited';
  readonly actor: ShelfActor;
}

interface StoredProposal {
  view: CategoryProposalView;
  readonly normalisedName: string;
}

export class MemorySellerCategoryStore implements SellerCategoryStore {
  proposals = new Map<string, StoredProposal>();
  shelves = new Map<string, ShelfView>();
  offers = new Map<string, MemoryOffer>();
  history: MemoryHistory[] = [];
  /** Live platform categories and their status. */
  readonly platform = new Map<string, string>();

  /** A copy of the state, put back on a rollback. */
  snapshot(): () => void {
    const proposals = new Map(
      [...this.proposals].map(([key, value]) => [key, { ...value }] as const),
    );
    const shelves = new Map(this.shelves);
    const offers = new Map([...this.offers].map(([key, value]) => [key, { ...value }] as const));
    const history = [...this.history];
    return () => {
      this.proposals = proposals;
      this.shelves = shelves;
      this.offers = offers;
      this.history = history;
    };
  }

  addProposal(_m: MarketContext, proposal: NewCategoryProposal) {
    const clash = [...this.proposals.values()].some(
      (stored) =>
        stored.view.status === 'pending' &&
        stored.view.sellerId === proposal.sellerId &&
        stored.view.platformParentId === proposal.platformParentId &&
        stored.normalisedName === proposal.normalisedName,
    );
    if (clash) return Promise.resolve('proposal.duplicate' as const);
    this.proposals.set(proposal.id, {
      normalisedName: proposal.normalisedName,
      view: {
        id: proposal.id,
        sellerId: proposal.sellerId,
        platformParentId: proposal.platformParentId,
        texts: proposal.texts,
        status: 'pending',
        reasonCode: null,
        createdSellerCategoryId: null,
        decidedAt: null,
        version: 1,
        createdAt: proposal.now,
      },
    });
    return Promise.resolve(null);
  }

  pendingCount(_m: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(
      [...this.proposals.values()].filter(
        (stored) => stored.view.sellerId === sellerId && stored.view.status === 'pending',
      ).length,
    );
  }

  activeShelfNamed(
    _m: MarketContext,
    sellerId: Id<'Seller'>,
    parentId: Id<'Category'>,
    normalisedName: string,
  ) {
    return Promise.resolve(
      [...this.proposals.values()].some((stored) => {
        const shelfId = stored.view.createdSellerCategoryId;
        const shelf = shelfId === null ? undefined : this.shelves.get(shelfId);
        return (
          stored.normalisedName === normalisedName &&
          shelf !== undefined &&
          shelf.status === 'active' &&
          shelf.sellerId === sellerId &&
          shelf.platformParentId === parentId
        );
      }),
    );
  }

  findProposal(_m: MarketContext, id: Id<'CategoryProposal'>) {
    return Promise.resolve(this.proposals.get(id)?.view ?? null);
  }

  decideProposal(
    _m: MarketContext,
    id: Id<'CategoryProposal'>,
    expectedVersion: number,
    decision: ProposalDecision,
    now: Temporal.Instant,
  ) {
    const stored = this.proposals.get(id);
    if (stored?.view.status !== 'pending' || stored.view.version !== expectedVersion) {
      return Promise.resolve(false);
    }
    stored.view = {
      ...stored.view,
      status: decision.status,
      reasonCode: decision.status === 'approved' ? null : decision.reason,
      createdSellerCategoryId: decision.status === 'approved' ? decision.shelfId : null,
      decidedAt: now,
      version: expectedVersion + 1,
    };
    return Promise.resolve(true);
  }

  async cancelPendingOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    reason: ProposalCancelReason,
    now: Temporal.Instant,
  ) {
    const cancelled: { id: Id<'CategoryProposal'>; version: number }[] = [];
    const pending = [...this.proposals.values()]
      .filter((stored) => stored.view.sellerId === sellerId && stored.view.status === 'pending')
      .sort((a, b) => compareInstants(a.view.createdAt, b.view.createdAt));
    for (const stored of pending) {
      const { id, version } = stored.view;
      if (await this.decideProposal(market, id, version, { status: 'cancelled', reason }, now)) {
        cancelled.push({ id, version: version + 1 });
      }
    }
    return cancelled;
  }

  listPending(
    _m: MarketContext,
    page: { readonly after: Id<'CategoryProposal'> | null; readonly limit: number },
  ) {
    const pending = [...this.proposals.values()]
      .map((stored) => stored.view)
      .filter((view) => view.status === 'pending')
      .sort((a, b) => compareInstants(a.createdAt, b.createdAt) || a.id.localeCompare(b.id));
    const from = page.after === null ? 0 : pending.findIndex((view) => view.id === page.after) + 1;
    return Promise.resolve(
      from === 0 && page.after !== null ? [] : pending.slice(from, from + page.limit),
    );
  }

  listOfSeller(_m: MarketContext, sellerId: Id<'Seller'>, limit: number) {
    return Promise.resolve(
      [...this.proposals.values()]
        .map((stored) => stored.view)
        .filter((view) => view.sellerId === sellerId)
        .sort((a, b) => compareInstants(b.createdAt, a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, limit),
    );
  }

  slugTaken(_m: MarketContext, sellerId: Id<'Seller'>, slug: string) {
    return Promise.resolve(
      [...this.shelves.values()].some(
        (shelf) => shelf.sellerId === sellerId && shelf.slug === slug,
      ),
    );
  }

  insertShelf(_m: MarketContext, shelf: NewShelf) {
    this.shelves.set(shelf.id, {
      id: shelf.id,
      sellerId: shelf.sellerId,
      platformParentId: shelf.platformParentId,
      slug: shelf.slug,
      status: 'active',
      mergedIntoId: null,
      texts: shelf.texts,
      version: 1,
    });
    return Promise.resolve();
  }

  findShelf(_m: MarketContext, id: Id<'SellerCategory'>) {
    return Promise.resolve(this.shelves.get(id) ?? null);
  }

  shelvesOfSeller(_m: MarketContext, sellerId: Id<'Seller'>) {
    const order = { active: 0, promoted: 1, merged: 2, archived: 3 };
    return Promise.resolve(
      [...this.shelves.values()]
        .filter((shelf) => shelf.sellerId === sellerId)
        .sort((a, b) => order[a.status] - order[b.status]),
    );
  }

  closeShelf(
    _m: MarketContext,
    id: Id<'SellerCategory'>,
    expectedVersion: number,
    close:
      | { readonly status: 'promoted' }
      | { readonly status: 'merged'; readonly into: Id<'Category'> },
  ) {
    const shelf = this.shelves.get(id);
    if (shelf?.status !== 'active' || shelf.version !== expectedVersion) {
      return Promise.resolve(false);
    }
    this.shelves.set(id, {
      ...shelf,
      status: close.status,
      mergedIntoId: close.status === 'merged' ? close.into : null,
      version: expectedVersion + 1,
    });
    return Promise.resolve(true);
  }

  clearShelfOnOffers(_m: MarketContext, shelfId: Id<'SellerCategory'>, actor: ShelfActor) {
    let count = 0;
    for (const offer of this.offers.values()) {
      if (offer.shelfId !== shelfId) continue;
      offer.shelfId = null;
      offer.version += 1;
      this.history.push({ offerId: offer.id, kind: 'shelf-cleared', actor });
      count += 1;
    }
    return Promise.resolve(count);
  }

  setOfferShelf(
    _m: MarketContext,
    change: {
      readonly offerId: Id<'Offer'>;
      readonly sellerId: Id<'Seller'>;
      readonly shelfId: Id<'SellerCategory'> | null;
      readonly expectedVersion: number;
      readonly actor: ShelfActor;
    },
  ) {
    const offer = this.offers.get(change.offerId);
    if (offer === undefined || offer.deleted || offer.sellerId !== change.sellerId) {
      return Promise.resolve('offer.not-found' as const);
    }
    if (offer.version !== change.expectedVersion) return Promise.resolve('conflict.stale' as const);
    offer.shelfId = change.shelfId;
    offer.version += 1;
    this.history.push({ offerId: offer.id, kind: 'edited', actor: change.actor });
    return Promise.resolve({ version: offer.version });
  }

  platformParentState(_m: MarketContext, id: Id<'Category'>) {
    const status = this.platform.get(id);
    return Promise.resolve(status === undefined ? null : { status });
  }
}

function compareInstants(a: Temporal.Instant, b: Temporal.Instant): number {
  return a.epochMilliseconds - b.epochMilliseconds;
}
