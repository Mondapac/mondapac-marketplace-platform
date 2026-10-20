import type { DeliveryLocatorSource, GeoPoint, MapBounds, Place } from './types.ts';

// Sample data of the Deliver to modal, from the approved prototype (deliver-to-a-teal.html v3).
// The map and address-lookup provider is not chosen (cost, privacy, address data), so these are
// made-up places on a box around Greater Brisbane, not real addresses or a real boundary.

const BOUNDS: MapBounds = { north: -27.2, south: -27.75, west: 152.75, east: 153.3 };

/** A point on the prototype's 400 x 400 map, in degrees. */
function at(x: number, y: number): GeoPoint {
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  return {
    lat: round(BOUNDS.north - (y / 400) * (BOUNDS.north - BOUNDS.south)),
    lng: round(BOUNDS.west + (x / 400) * (BOUNDS.east - BOUNDS.west)),
  };
}

function place(
  id: string,
  street: string,
  suburb: string,
  postcode: string,
  [x, y]: readonly [number, number],
): Place {
  return { id, street, suburb, region: 'QLD', postcode, point: at(x, y) };
}

const SUBURBS: readonly Place[] = [
  place('kedron', '', 'Kedron', '4031', [190, 120]),
  place('brisbane-city', '', 'Brisbane City', '4000', [225, 170]),
  place('paddington', '', 'Paddington', '4064', [165, 172]),
  place('mt-gravatt', '', 'Mt Gravatt', '4122', [255, 265]),
  place('sunnybank', '', 'Sunnybank', '4109', [235, 315]),
  place('inala', '', 'Inala', '4077', [140, 290]),
  place('moorooka', '', 'Moorooka', '4107', [190, 245]),
  place('indooroopilly', '', 'Indooroopilly', '4068', [110, 190]),
];

const ADDRESSES: readonly Place[] = [
  place('a1', '12 Example Street', 'Kedron', '4031', [192, 118]),
  place('a2', 'Level 3, 100 Sample Road', 'Brisbane City', '4000', [225, 170]),
  place('a3', '22 Test Street', 'Paddington', '4064', [166, 174]),
  place('a4', '45 Sample Avenue', 'Mt Gravatt', '4122', [252, 262]),
  place('a5', '8 Demo Road', 'Sunnybank', '4109', [236, 312]),
  place('a6', '5 Outer Lane', 'Toowoomba', '4350', [372, 352]),
];

export const SAMPLE_DELIVERY_LOCATOR: DeliveryLocatorSource = {
  // Launch area (ServiceArea config): Greater Brisbane. The boundary is a sample shape.
  area: {
    name: 'Greater Brisbane',
    boundary: (
      [
        [95, 120],
        [150, 70],
        [250, 60],
        [320, 100],
        [345, 190],
        [330, 280],
        [270, 340],
        [190, 350],
        [120, 320],
        [85, 240],
      ] as const
    ).map(([x, y]) => at(x, y)),
  },
  bounds: BOUNDS,
  start: SUBURBS[1]!,
  addresses: ADDRESSES,
  suburbs: SUBURBS,
};
