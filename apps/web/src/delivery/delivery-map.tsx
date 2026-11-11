'use client';

import dynamic from 'next/dynamic';
import type { DeliveryLocatorSource } from '../storefront/types.ts';
import { StubMap, type DeliveryMapProps } from './stub-map.tsx';

/** The Mapbox map and its stylesheet: their own chunk, fetched only when the modal opens. */
const MapboxMap = dynamic(() => import('./mapbox-map.tsx').then((m) => m.MapboxMap), {
  ssr: false,
  loading: () => <div className="lmmap gl" aria-busy="true" />,
});

/** The real map when the source has one (MAPBOX_MAP_TOKEN, ADR-0048), else the drawn stub. */
export function DeliveryMap({
  map,
  ...props
}: DeliveryMapProps & { readonly map: DeliveryLocatorSource['map'] }) {
  return map ? (
    <MapboxMap {...props} token={map.token} style={map.style} />
  ) : (
    <StubMap {...props} />
  );
}
