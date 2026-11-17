import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CustomerDirectoryEntry } from '../../domain/customer-read-models';
import {
  isSuspicious,
  type InviteLink,
  type SellerAttribution,
} from '../../domain/seller-invitations';
import {
  ATTRIBUTION_VIEWS,
  type AttributionListRecord,
  type AttributionSelector,
  type AttributionView,
  type InviteLinkRepository,
  type InviteTokens,
  type SellerAttributionRepository,
} from '../ports/seller-invitations.repository';

type Stored<T> = T & { readonly marketId: string };

const unstored = <T>(row: Stored<T>): T => {
  const copy: Record<string, unknown> = { ...row };
  delete copy['marketId'];
  return copy as T;
};

/** {@link InviteLinkRepository} in memory: one live link per seller, as the partial index. */
export class InMemoryInviteLinks implements InviteLinkRepository {
  rows: Stored<InviteLink>[] = [];

  liveOf(market: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(
      this.rows.find(
        (row) =>
          row.marketId === market.marketId && row.sellerId === sellerId && row.revokedAt === null,
      ) ?? null,
    );
  }

  findByToken(market: MarketContext, token: string) {
    return Promise.resolve(
      this.rows.find((row) => row.marketId === market.marketId && row.token === token) ?? null,
    );
  }

  replace(market: MarketContext, link: InviteLink, at: Temporal.Instant) {
    if (this.rows.some((row) => row.marketId === market.marketId && row.token === link.token)) {
      return Promise.resolve('conflict' as const);
    }
    this.rows = this.rows.map((row) =>
      row.marketId === market.marketId && row.sellerId === link.sellerId && row.revokedAt === null
        ? { ...row, revokedAt: at }
        : row,
    );
    this.rows.push({ ...link, marketId: market.marketId });
    return Promise.resolve('ok' as const);
  }
}

const DAY_MS = 86_400_000;
const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/**
 * {@link SellerAttributionRepository} in memory. The directory gives the listed fields; a row
 * whose directory row is gone is not listed (the foreign key cascades in the database).
 */
export class InMemorySellerAttributions implements SellerAttributionRepository {
  rows: Stored<SellerAttribution>[] = [];

  constructor(private readonly directory: Map<string, CustomerDirectoryEntry>) {}

  private listed(row: Stored<SellerAttribution>): AttributionListRecord | null {
    const entry = this.directory.get(`${row.marketId}:${row.accountId}`);
    if (entry === undefined) return null;
    return { ...unstored(row), email: entry.email, displayName: entry.displayName };
  }

  findOf(market: MarketContext, accountId: Id<'Account'>) {
    const row = this.rows.find((r) => r.marketId === market.marketId && r.accountId === accountId);
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve(unstored<SellerAttribution>(row));
  }

  insert(market: MarketContext, attribution: SellerAttribution) {
    if (
      this.rows.some((r) => r.marketId === market.marketId && r.accountId === attribution.accountId)
    ) {
      return Promise.resolve('exists' as const);
    }
    if (!this.directory.has(`${market.marketId}:${attribution.accountId}`)) {
      throw new Error('foreign key violation: seller_attributions -> customer_directory');
    }
    this.rows.push({ ...attribution, marketId: market.marketId });
    return Promise.resolve('ok' as const);
  }

  update(market: MarketContext, attribution: SellerAttribution, expectedVersion: number) {
    const index = this.rows.findIndex(
      (r) =>
        r.marketId === market.marketId &&
        r.accountId === attribution.accountId &&
        r.version === expectedVersion,
    );
    if (index < 0) return Promise.resolve(false);
    this.rows[index] = { ...attribution, marketId: market.marketId };
    return Promise.resolve(true);
  }

  countOfLinkSince(market: MarketContext, linkId: Id<'SellerInviteLink'>, since: Temporal.Instant) {
    return Promise.resolve(
      this.rows.filter(
        (r) =>
          r.marketId === market.marketId &&
          r.linkId === linkId &&
          r.attributedAt.epochMilliseconds >= since.epochMilliseconds,
      ).length,
    );
  }

  countsOfSeller(market: MarketContext, sellerId: Id<'Seller'>) {
    const mine = this.rows.filter((r) => r.marketId === market.marketId && r.sellerId === sellerId);
    return Promise.resolve({
      active: mine.filter((r) => r.status === 'active').length,
      rejected: mine.filter((r) => r.status === 'rejected').length,
    });
  }

  private inView(row: SellerAttribution, view: AttributionView): boolean {
    switch (view) {
      case 'suspicious':
        return isSuspicious(row);
      case 'all':
        return true;
      case 'active':
        return row.status === 'active';
      case 'rejected':
        return row.status === 'rejected';
    }
  }

  private matching(market: MarketContext, s: AttributionSelector, direction: 'asc' | 'desc') {
    const rows = this.rows
      .filter((row) => row.marketId === market.marketId && this.inView(row, s.view))
      .map((row) => this.listed(row))
      .filter((row): row is AttributionListRecord => row !== null)
      .filter((row) => {
        if (s.emailPrefix !== null && !row.email.toLowerCase().startsWith(s.emailPrefix)) {
          return false;
        }
        if (s.sellerId !== null && row.sellerId !== s.sellerId) return false;
        if (s.status !== null && row.status !== s.status) return false;
        if (s.rejectReason !== null && row.rejectReason !== s.rejectReason) return false;
        if (s.flag !== null && !row.flags.includes(s.flag)) return false;
        const at = row.attributedAt.epochMilliseconds;
        if (s.attributedFrom !== null && at < dayStart(s.attributedFrom)) return false;
        if (s.attributedTo !== null && at >= dayStart(s.attributedTo) + DAY_MS) return false;
        return true;
      });
    const sign = direction === 'asc' ? 1 : -1;
    return rows.sort((a, b) => {
      const by = a.attributedAt.epochMilliseconds - b.attributedAt.epochMilliseconds;
      if (by !== 0) return sign * by;
      return sign * (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0);
    });
  }

  page(
    market: MarketContext,
    selector: AttributionSelector,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ) {
    return Promise.resolve(
      this.matching(market, selector, direction).slice(window.offset, window.offset + window.limit),
    );
  }

  count(market: MarketContext, selector: AttributionSelector) {
    return Promise.resolve(this.matching(market, selector, 'desc').length);
  }

  viewCounts(market: MarketContext) {
    const mine = this.rows.filter((row) => row.marketId === market.marketId);
    return Promise.resolve(
      Object.fromEntries(
        ATTRIBUTION_VIEWS.map((view) => [
          view,
          mine.filter((row) => this.inView(row, view)).length,
        ]),
      ) as Record<AttributionView, number>,
    );
  }

  accountIds(market: MarketContext, selector: AttributionSelector, limit: number) {
    return Promise.resolve(
      this.matching(market, selector, 'desc')
        .slice(0, limit)
        .map((row) => row.accountId),
    );
  }

  findListed(market: MarketContext, accountIds: readonly Id<'Account'>[]) {
    return Promise.resolve(
      accountIds.flatMap((accountId) => {
        const row = this.rows.find(
          (r) => r.marketId === market.marketId && r.accountId === accountId,
        );
        const listed = row === undefined ? null : this.listed(row);
        return listed === null ? [] : [listed];
      }),
    );
  }

  /** The directory's deletion cascades to the row. */
  removeAccount(market: MarketContext, accountId: Id<'Account'>) {
    this.rows = this.rows.filter(
      (r) => !(r.marketId === market.marketId && r.accountId === accountId),
    );
  }
}

/** {@link InviteTokens} from a script, then a counter (deterministic tests). */
export class ScriptedInviteTokens implements InviteTokens {
  #n = 0;

  constructor(private readonly script: string[] = []) {}

  next(): string {
    const scripted = this.script.shift();
    if (scripted !== undefined) return scripted;
    this.#n += 1;
    return `T${this.#n.toString().padStart(25, '0')}`;
  }
}
