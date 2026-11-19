import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { AdminDayZone } from '../application/ports/admin-day-zone';
import type { IdentityManagementPeer } from '../application/ports/customer-management-peers';

/**
 * {@link AdminDayZone}: the admin's own zone from `identity.describeActor` (the caller's context,
 * unchanged), else the Market's configured zone. A refused or failed read, an empty zone or one that
 * is not a time zone id Temporal knows (a stored setting is not trusted to be valid) is the Market's
 * zone: the zone only places a day boundary, it grants nothing, and must never turn a read into a
 * 500.
 */
export class ActorOrMarketDayZone implements AdminDayZone {
  constructor(
    private readonly markets: MarketRegistry,
    private readonly identity: Pick<IdentityManagementPeer, 'describeActor'>,
  ) {}

  async zoneOf(context: CallContext): Promise<string> {
    const market = this.markets.get(context.market.marketId).timezone;
    try {
      const actor = await this.identity.describeActor(context);
      const own = actor.ok ? (actor.value.timezone ?? null) : null;
      return isTimeZone(own) ? own : market;
    } catch {
      return market;
    }
  }
}

/** Whether `zone` is a non-empty time zone id that Temporal can place a day in. */
function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone === '') return false;
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}
