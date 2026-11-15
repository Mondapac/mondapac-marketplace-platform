import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AreaPolicyRecord,
  DueDaysRecord,
  PolicyRepository,
  Stamp,
} from '../application/ports/policy.repository';
import type { PolicyArea, Risk } from '../domain/areas';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface AreaRow {
  readonly area: string;
  readonly enabled: boolean;
  readonly defaultRisk: string;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedByAccountId: string;
}

const toArea = (row: AreaRow): AreaPolicyRecord => ({
  area: row.area as PolicyArea,
  enabled: row.enabled,
  risk: row.defaultRisk as Risk,
  version: row.version,
  updatedAt: toInstant(row.updatedAt),
  updatedBy: row.updatedByAccountId as Id<'Account'>,
});

/**
 * {@link PolicyRepository} on `system_requests.policy_areas` and `policy_settings`, scoped by
 * `marketId`. The first write of a row is an insert the primary key refuses twice; a later one
 * updates the version it replaces only.
 */
export class PrismaPolicyRepository implements PolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async areas(market: MarketContext) {
    const rows = await this.prisma
      .tx(market)
      .systemRequestsPolicyArea.findMany({ where: { marketId: market.marketId } });
    return rows.map(toArea);
  }

  async area(market: MarketContext, area: PolicyArea) {
    const row = await this.prisma
      .tx(market)
      .systemRequestsPolicyArea.findFirst({ where: { marketId: market.marketId, area } });
    return row === null ? null : toArea(row);
  }

  async setArea(
    market: MarketContext,
    area: PolicyArea,
    value: { readonly enabled: boolean; readonly risk: Risk },
    stamp: Stamp,
  ) {
    const tx = this.prisma.tx(market);
    const data = {
      enabled: value.enabled,
      defaultRisk: value.risk,
      version: stamp.version,
      updatedAt: toDate(stamp.at),
      updatedByAccountId: stamp.by,
    };
    if (stamp.version === 1) {
      const created = await tx.systemRequestsPolicyArea.createMany({
        data: [{ marketId: market.marketId, tenantId: market.tenantId, area, ...data }],
        skipDuplicates: true,
      });
      return created.count === 1;
    }
    const updated = await tx.systemRequestsPolicyArea.updateMany({
      where: { marketId: market.marketId, area, version: stamp.version - 1 },
      data,
    });
    return updated.count === 1;
  }

  async dueDays(market: MarketContext): Promise<DueDaysRecord | null> {
    const row = await this.prisma
      .tx(market)
      .systemRequestsPolicySetting.findFirst({ where: { marketId: market.marketId } });
    return row === null
      ? null
      : {
          reviewDueDays: row.reviewDueDays,
          version: row.version,
          updatedAt: toInstant(row.updatedAt),
          updatedBy: row.updatedByAccountId as Id<'Account'>,
        };
  }

  async setDueDays(market: MarketContext, days: number, stamp: Stamp) {
    const tx = this.prisma.tx(market);
    const data = {
      reviewDueDays: days,
      version: stamp.version,
      updatedAt: toDate(stamp.at),
      updatedByAccountId: stamp.by,
    };
    if (stamp.version === 1) {
      const created = await tx.systemRequestsPolicySetting.createMany({
        data: [{ marketId: market.marketId, tenantId: market.tenantId, ...data }],
        skipDuplicates: true,
      });
      return created.count === 1;
    }
    const updated = await tx.systemRequestsPolicySetting.updateMany({
      where: { marketId: market.marketId, version: stamp.version - 1 },
      data,
    });
    return updated.count === 1;
  }
}
