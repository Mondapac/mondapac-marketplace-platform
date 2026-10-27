import type { CarrierGateway, FleetCode } from '../application/ports/carrier-gateway';
import type { FleetRegistry } from '../application/ports/fleet-registry';

/** A registry over a fixed list of gateways, one per fleet code. */
export class StaticFleetRegistry implements FleetRegistry {
  readonly #byFleet = new Map<FleetCode, CarrierGateway>();

  constructor(gateways: readonly CarrierGateway[]) {
    for (const gateway of gateways) {
      if (this.#byFleet.has(gateway.fleet)) {
        throw new Error(`fleet registry: ${gateway.fleet} is registered twice`);
      }
      this.#byFleet.set(gateway.fleet, gateway);
    }
  }

  get(fleet: FleetCode): CarrierGateway | undefined {
    return this.#byFleet.get(fleet);
  }

  all(): readonly CarrierGateway[] {
    return [...this.#byFleet.values()];
  }
}
