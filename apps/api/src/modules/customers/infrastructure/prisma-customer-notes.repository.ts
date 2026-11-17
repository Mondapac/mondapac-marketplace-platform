import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { CustomerNoteRepository } from '../application/ports/customer-notes.repository';
import type { StoredCustomerNote } from '../domain/customer-note';

/** {@link CustomerNoteRepository} on `customers.customer_notes`; `marketId` in every `where`. */
export class PrismaCustomerNoteRepository implements CustomerNoteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(market: MarketContext, note: StoredCustomerNote): Promise<void> {
    await this.prisma.tx(market).customersCustomerNote.create({
      data: {
        id: note.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: note.accountId,
        authorAccountId: note.authorAccountId,
        bodyCiphertext: note.bodySealed,
        createdAt: new Date(note.createdAt.epochMilliseconds),
      },
    });
  }

  async page(
    market: MarketContext,
    accountId: Id<'Account'>,
    after: { readonly createdAt: Temporal.Instant; readonly id: string } | null,
    limit: number,
  ): Promise<readonly StoredCustomerNote[]> {
    const at = after === null ? null : new Date(after.createdAt.epochMilliseconds);
    const rows = await this.prisma.tx(market).customersCustomerNote.findMany({
      where: {
        marketId: market.marketId,
        accountId,
        ...(at === null || after === null
          ? {}
          : { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: after.id } }] }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id as Id<'CustomerNote'>,
      accountId: row.accountId as Id<'Account'>,
      authorAccountId: row.authorAccountId as Id<'Account'>,
      bodySealed: row.bodyCiphertext,
      createdAt: Temporal.Instant.fromEpochMilliseconds(row.createdAt.getTime()),
    }));
  }

  count(market: MarketContext, accountId: Id<'Account'>): Promise<number> {
    return this.prisma
      .tx(market)
      .customersCustomerNote.count({ where: { marketId: market.marketId, accountId } });
  }
}
