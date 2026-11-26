import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AreaOutline } from '../ports/shipping-policy';
import type { ShippingDependencies } from '../shipping-dependencies';

/** The box around the outlines, in degrees; the storefront map opens on it. */
export interface MapBox {
  readonly north: number;
  readonly south: number;
  readonly west: number;
  readonly east: number;
}

export interface DeliveryAreaMapView {
  readonly areas: readonly {
    readonly code: string;
    readonly names: Readonly<Record<string, string>>;
    readonly boundary: AreaOutline;
  }[];
  /** Around every outline; null when no area is shown. */
  readonly bounds: MapBox | null;
  readonly source: {
    readonly name: string;
    readonly licence: string;
    readonly attribution: string;
  } | null;
}

/**
 * `shipping.delivery-area-map`: the outlines of the Market's ServiceAreas open for delivery, for
 * the storefront's Deliver to map (FE-098). The answer is public configuration only: area code,
 * names and shape, built from public postal-area data. Nothing about a seller, an address or the
 * caller is read or stored, so anyone may ask. The postcode check (`shipping.delivery-area`)
 * still decides; the outline is a guide.
 */
export class DeliveryAreaMap extends UseCase<Record<string, never>, DeliveryAreaMapView, never> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.delivery-area-map',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<DeliveryAreaMapView, never>> {
    const outlines = this.deps.policy.deliveryAreaOutlines(context.market);
    return Promise.resolve(
      ok({
        areas: outlines.areas.map(({ code, names, boundary }) => ({ code, names, boundary })),
        bounds: boxOf(outlines.areas.map((area) => area.boundary)),
        source: outlines.source,
      }),
    );
  }
}

function boxOf(outlines: readonly AreaOutline[]): MapBox | null {
  let box: { north: number; south: number; west: number; east: number } | null = null;
  for (const outline of outlines) {
    for (const polygon of outline.coordinates) {
      // The outer ring holds the holes, so it alone sets the box.
      for (const [lng, lat] of polygon[0] ?? []) {
        if (box === null) box = { north: lat, south: lat, west: lng, east: lng };
        box.north = Math.max(box.north, lat);
        box.south = Math.min(box.south, lat);
        box.west = Math.min(box.west, lng);
        box.east = Math.max(box.east, lng);
      }
    }
  }
  return box;
}
