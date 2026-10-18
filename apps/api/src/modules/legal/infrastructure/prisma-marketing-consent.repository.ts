import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  MarketingConsentChange,
  MarketingConsentRecord,
  MarketingConsentRepository,
} from '../application/ports/marketing-consent.repository';
import type { ConsentSource, MarketingChannel } from '../domain/marketing-consent';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link MarketingConsentRepository} on `legal.marketing_consents` and its append-only history
 * `legal.marketing_consent_changes`, scoped by `marketId` and the account in every `where`.
 */
export class PrismaMarketingConsentRepository implements MarketingConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    market: MarketContext,
    accountId: Id<'Account'>,
    channel: MarketingChannel,
  ): Promise<MarketingConsentRecord | null> {
    const row = await this.prisma.tx(market).legalMarketingConsent.findFirst({
      where: { marketId: market.marketId, accountId, channel },
    });
    if (row === null) return null;
    return {
      id: row.id as Id<'MarketingConsent'>,
      accountId: row.accountId as Id<'Account'>,
      channel: row.channel as MarketingChannel,
      granted: row.granted,
      source: row.source as ConsentSource,
      changedAt: toInstant(row.changedAt),
      createdAt: toInstant(row.createdAt),
    };
  }

  async record(
    market: MarketContext,
    current: MarketingConsentRecord,
    change: MarketingConsentChange,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const changed = await tx.legalMarketingConsent.updateMany({
      where: { marketId: market.marketId, accountId: current.accountId, channel: current.channel },
      data: {
        granted: current.granted,
        source: current.source,
        changedAt: toDate(current.changedAt),
      },
    });
    if (changed.count === 0) {
      await tx.legalMarketingConsent.create({
        data: {
          id: current.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: current.accountId,
          channel: current.channel,
          granted: current.granted,
          source: current.source,
          changedAt: toDate(current.changedAt),
          createdAt: toDate(current.createdAt),
        },
      });
    }
    await tx.legalMarketingConsentChange.create({
      data: {
        id: change.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: change.accountId,
        channel: change.channel,
        granted: change.granted,
        source: change.source,
        occurredAt: toDate(change.occurredAt),
      },
    });
  }
}
