import type { FactoryProvider } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  SELLER_ACCOUNT_READER,
  type OpenSellerOwnerInvitation,
  type OwnedSellerQuery,
  type SellerAccountReader,
  type SellerAccountRecord,
} from '../../application/ports/seller-account-reader';
import type { SellerAccessStateCode, SellerOrigin } from '../../domain/seller-access';

const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * The membership filter of the Seller Owner (the rule of `readSellerPeople`): active, of an
 * account of the seller population whose one assignment is the system role of the seller
 * scope; with `verified`, an account whose email is confirmed. `market_id` in every level.
 */
function ownerMembership(market: MarketContext, verified: boolean) {
  const marketId = market.marketId;
  return {
    marketId,
    state: 'active',
    account: {
      marketId,
      population: 'seller',
      ...(verified ? { emailVerifiedAt: { not: null } } : {}),
      roleAssignments: {
        some: { marketId, role: { marketId, scope: 'seller', kind: 'system' } },
      },
    },
  };
}

function selected(market: MarketContext, verified: boolean) {
  return {
    sellerId: true,
    origin: true,
    state: true,
    stateChangedAt: true,
    reapplyCount: true,
    memberships: {
      where: ownerMembership(market, verified),
      // One owner per seller in Phase 2; a second would be a broken store, and the lowest
      // account id is answered, deterministically.
      orderBy: { accountId: 'asc' as const },
      take: 1,
      select: {
        account: { select: { id: true, email: true, displayName: true, emailVerifiedAt: true } },
      },
    },
  } as const;
}

interface SellerRow {
  readonly sellerId: string;
  readonly origin: string;
  readonly state: string;
  readonly stateChangedAt: Date;
  readonly reapplyCount: number;
  readonly memberships: readonly {
    readonly account: {
      readonly id: string;
      readonly email: string;
      readonly displayName: string | null;
      readonly emailVerifiedAt: Date | null;
    };
  }[];
}

function recordOf(row: SellerRow): SellerAccountRecord {
  const owner = row.memberships[0]?.account;
  return {
    sellerId: row.sellerId as Id<'Seller'>,
    // The CHECKs of `seller_access` hold the codes (data design 3.9).
    origin: row.origin as SellerOrigin,
    state: row.state as SellerAccessStateCode,
    stateChangedAt: toInstant(row.stateChangedAt),
    reapplyCount: row.reapplyCount,
    owner:
      owner === undefined
        ? null
        : {
            accountId: owner.id as Id<'Account'>,
            email: owner.email,
            displayName: owner.displayName,
            emailVerified: owner.emailVerifiedAt !== null,
          },
  };
}

/**
 * {@link SellerAccountReader} on `identity`'s own tables (data design 3.3, 3.9, 3.10; slice 9b):
 * every statement through `PrismaService.tx(market)` with `marketId` at the top level of
 * `where` and in each relation filter. No table of `sellers` is read. The indexes are those
 * Mojtaba named for 9b, so no new one: by state `seller_access_market_id_state_state_changed_at_idx`;
 * the exact email `accounts_market_id_population_email_normalized_key`, then
 * `seller_memberships_market_id_account_id_idx`; the owners of a page or of the summaries
 * `seller_memberships_market_id_seller_id_state_idx` and the `accounts` key `(market_id, id)`.
 * Selects the address and the name, never a credential or a token hash.
 */
export class PrismaSellerAccountReader implements SellerAccountReader {
  constructor(private readonly prisma: PrismaService) {}

  async ownedSellers(
    market: MarketContext,
    query: OwnedSellerQuery,
  ): Promise<SellerAccountRecord[]> {
    if (query.sellerIds !== null && query.sellerIds.length === 0) return [];
    const rows = await this.prisma.tx(market).identitySellerAccess.findMany({
      where: {
        marketId: market.marketId,
        registeredAt: { not: null },
        ...(query.state === null ? {} : { state: query.state }),
        sellerId: {
          ...(query.after === null ? {} : { gt: query.after }),
          ...(query.sellerIds === null ? {} : { in: [...query.sellerIds] }),
        },
        memberships: {
          some: {
            ...ownerMembership(market, true),
            ...(query.ownerAccountId === null ? {} : { accountId: query.ownerAccountId }),
          },
        },
      },
      select: selected(market, true),
      orderBy: { sellerId: 'asc' },
      take: query.limit,
    });
    return rows.map(recordOf);
  }

  async summariesOf(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<SellerAccountRecord[]> {
    if (sellerIds.length === 0) return [];
    const rows = await this.prisma.tx(market).identitySellerAccess.findMany({
      where: {
        marketId: market.marketId,
        registeredAt: { not: null },
        sellerId: { in: [...sellerIds] },
      },
      select: selected(market, false),
    });
    return rows.map(recordOf);
  }

  async sellersOfAddress(
    market: MarketContext,
    emailNormalized: string,
  ): Promise<{ readonly accountId: Id<'Account'>; readonly sellerIds: Id<'Seller'>[] } | null> {
    // Equality on the three columns of the unique key, as `findByEmail`.
    const account = await this.prisma.tx(market).identityAccount.findFirst({
      where: { marketId: market.marketId, population: 'seller', emailNormalized },
      select: { id: true },
    });
    if (account === null) return null;
    const memberships = await this.prisma.tx(market).identitySellerMembership.findMany({
      where: { marketId: market.marketId, accountId: account.id, state: 'active' },
      select: { sellerId: true },
      orderBy: { sellerId: 'asc' },
    });
    return {
      accountId: account.id as Id<'Account'>,
      sellerIds: memberships.map((row) => row.sellerId as Id<'Seller'>),
    };
  }

  async openOwnerInvitations(
    market: MarketContext,
    query: {
      readonly emailNormalized: string | null;
      readonly after: Id<'Invitation'> | null;
      readonly limit: number;
    },
  ): Promise<OpenSellerOwnerInvitation[]> {
    const rows = await this.prisma.tx(market).identityInvitation.findMany({
      where: {
        marketId: market.marketId,
        kind: 'seller-owner',
        state: 'pending',
        sellerId: { not: null },
        ...(query.emailNormalized === null ? {} : { emailNormalized: query.emailNormalized }),
        ...(query.after === null ? {} : { id: { gt: query.after } }),
      },
      select: {
        id: true,
        sellerId: true,
        email: true,
        displayName: true,
        invitedByAccountId: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { id: 'asc' },
      take: query.limit,
    });
    return rows.map((row) => ({
      id: row.id as Id<'Invitation'>,
      sellerId: row.sellerId as Id<'Seller'>,
      state: 'pending' as const,
      // A pending invitation keeps its address (the CHECK of data design 3.10).
      email: row.email ?? '',
      displayName: row.displayName,
      invitedByAccountId: row.invitedByAccountId as Id<'Account'> | null,
      expiresAt: row.expiresAt === null ? null : toInstant(row.expiresAt),
      createdAt: toInstant(row.createdAt),
    }));
  }
}

/** Binds {@link SELLER_ACCOUNT_READER} (only `infrastructure/` may reach `PrismaService`). */
export const sellerAccountReaderProvider: FactoryProvider<SellerAccountReader> = {
  provide: SELLER_ACCOUNT_READER,
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => new PrismaSellerAccountReader(prisma),
};
