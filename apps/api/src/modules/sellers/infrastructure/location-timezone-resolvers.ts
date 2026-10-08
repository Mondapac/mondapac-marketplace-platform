import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  DevicePosition,
  LocationTimezoneResolver,
} from '../application/ports/location-timezone-resolver';

/** The default adapter: never suggests a zone (spike 3 record). */
export class NoneLocationTimezoneResolver implements LocationTimezoneResolver {
  zoneFor(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

/**
 * The adapter of tests: answers what a function says for the Market and the position, and
 * records nothing about the position. Not bound by the module.
 */
export class FakeLocationTimezoneResolver implements LocationTimezoneResolver {
  constructor(
    private readonly answer: (market: MarketContext, position: DevicePosition) => string | null,
  ) {}

  zoneFor(market: MarketContext, position: DevicePosition): Promise<string | null> {
    return Promise.resolve(this.answer(market, position));
  }
}
