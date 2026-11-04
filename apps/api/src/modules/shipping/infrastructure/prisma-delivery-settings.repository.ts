import type { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ActorId } from '../application/ports/fleet-selection.repository';
import type { DeliverySettingsRepository } from '../application/ports/delivery-settings.repository';
import { isRoundingStep, type DeliveryMargin } from '../domain/delivery-margin';
import {
  DELIVERY_METHODS,
  isDeliveryMethod,
  type DeliveryMethod,
} from '../domain/delivery-methods';
import {
  DEFAULT_DELIVERY_SETTINGS,
  type DeliverySettings,
  type DeliverySettingsInput,
} from '../domain/delivery-settings';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

interface SettingsRow {
  readonly pickupEnabled: boolean;
  readonly instantEnabled: boolean;
  readonly sameDayEnabled: boolean;
  readonly scheduledEnabled: boolean;
  readonly sameDayCutoffMinutes: number;
  readonly scheduledDaysAhead: number;
  readonly scheduledWindowMinutes: number;
  readonly readyPrepMinutes: number;
  readonly marginKind: string;
  readonly marginBasisPoints: number | null;
  readonly marginFixedMinor: number | null;
  readonly roundingStepMinor: number;
  readonly version: number;
}

/** The stored margin; a row the CHECKs would have refused reads as no margin (fail to the safe side). */
function marginOf(row: SettingsRow): DeliveryMargin {
  if (row.marginKind === 'percent' && row.marginBasisPoints !== null) {
    return { kind: 'percent', basisPoints: row.marginBasisPoints };
  }
  if (row.marginKind === 'fixed' && row.marginFixedMinor !== null) {
    return { kind: 'fixed', amountMinor: row.marginFixedMinor };
  }
  return { kind: 'none' };
}

function toSettings(row: SettingsRow): DeliverySettings {
  return {
    enabled: {
      pickup: row.pickupEnabled,
      instant: row.instantEnabled,
      same_day: row.sameDayEnabled,
      scheduled: row.scheduledEnabled,
    },
    sameDayCutoffMinutes: row.sameDayCutoffMinutes,
    scheduledDaysAhead: row.scheduledDaysAhead,
    scheduledWindowMinutes: row.scheduledWindowMinutes,
    readyPrepMinutes: row.readyPrepMinutes,
    margin: marginOf(row),
    roundingStepMinor: isRoundingStep(row.roundingStepMinor) ? row.roundingStepMinor : 1,
    version: row.version,
  };
}

function columnsOf(settings: DeliverySettingsInput) {
  const { margin } = settings;
  return {
    pickupEnabled: settings.enabled.pickup,
    instantEnabled: settings.enabled.instant,
    sameDayEnabled: settings.enabled.same_day,
    scheduledEnabled: settings.enabled.scheduled,
    sameDayCutoffMinutes: settings.sameDayCutoffMinutes,
    scheduledDaysAhead: settings.scheduledDaysAhead,
    scheduledWindowMinutes: settings.scheduledWindowMinutes,
    readyPrepMinutes: settings.readyPrepMinutes,
    marginKind: margin.kind,
    marginBasisPoints: margin.kind === 'percent' ? margin.basisPoints : null,
    marginFixedMinor: margin.kind === 'fixed' ? margin.amountMinor : null,
    roundingStepMinor: settings.roundingStepMinor,
  };
}

/**
 * {@link DeliverySettingsRepository} on `shipping.delivery_settings` and
 * `shipping.seller_delivery_methods`, scoped by `marketId` in every `where`.
 */
export class PrismaDeliverySettingsRepository implements DeliverySettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async settings(market: MarketContext): Promise<DeliverySettings> {
    const row = await this.prisma
      .tx(market)
      .shippingDeliverySettings.findFirst({ where: { marketId: market.marketId } });
    return row === null ? DEFAULT_DELIVERY_SETTINGS : toSettings(row);
  }

  async saveSettings(
    market: MarketContext,
    settings: DeliverySettingsInput,
    expectedVersion: number,
    by: ActorId,
    at: Temporal.Instant,
  ): Promise<DeliverySettings | 'conflict'> {
    const tx = this.prisma.tx(market);
    const columns = columnsOf(settings);
    const version = expectedVersion + 1;
    if (expectedVersion === 0) {
      // The first save: a second one racing it inserts nothing and is a conflict.
      const created = await tx.shippingDeliverySettings.createMany({
        data: [
          {
            marketId: market.marketId,
            tenantId: market.tenantId,
            ...columns,
            version,
            updatedAt: toDate(at),
            updatedBy: by,
          },
        ],
        skipDuplicates: true,
      });
      return created.count === 1 ? { ...settings, version } : 'conflict';
    }
    const updated = await tx.shippingDeliverySettings.updateMany({
      where: { marketId: market.marketId, version: expectedVersion },
      data: { ...columns, version, updatedAt: toDate(at), updatedBy: by },
    });
    return updated.count === 1 ? { ...settings, version } : 'conflict';
  }

  async unsupportedOf(market: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    const map = new Map<Id<'Seller'>, readonly DeliveryMethod[]>();
    if (sellerIds.length === 0) return map;
    const rows = await this.prisma.tx(market).shippingSellerDeliveryMethods.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
    });
    for (const row of rows) {
      const methods = new Set(row.unsupported.filter(isDeliveryMethod));
      map.set(
        row.sellerId as Id<'Seller'>,
        DELIVERY_METHODS.filter((method) => methods.has(method)),
      );
    }
    return map;
  }

  async setUnsupported(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    methods: readonly DeliveryMethod[],
    by: ActorId,
    at: Temporal.Instant,
  ) {
    await this.prisma.tx(market).shippingSellerDeliveryMethods.upsert({
      where: {
        marketId: market.marketId,
        marketId_sellerId: { marketId: market.marketId, sellerId },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId,
        unsupported: [...methods],
        updatedAt: toDate(at),
        updatedBy: by,
      },
      update: { unsupported: [...methods], updatedAt: toDate(at), updatedBy: by },
    });
  }
}
