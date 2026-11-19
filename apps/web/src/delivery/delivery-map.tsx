'use client';

import { useTranslations } from 'next-intl';
import { lazy, Suspense } from 'react';
import type { DeliveryLocatorSource } from '../storefront/types.ts';
import { StubMap, type DeliveryMapProps } from './stub-map.tsx';

/**
 * The Mapbox map and its stylesheet: their own chunk, fetched only when the modal opens (the
 * modal renders only on the client, after it is opened).
 */
const MapboxMap = lazy(() => import('./mapbox-map.tsx').then((m) => ({ default: m.MapboxMap })));

/** While the map's chunk loads: the box, its close button (the only way out on phones) and a status. */
function MapLoading({ children }: Pick<DeliveryMapProps, 'children'>) {
  const t = useTranslations('deliver');
  return (
    <div className="lmmap gl" aria-busy="true">
      {children}
      <p className="lmload" role="status">
        {t('map-loading')}
      </p>
    </div>
  );
}

/** The real map when the source has one (MAPBOX_MAP_TOKEN, ADR-0048), else the drawn stub. */
export function DeliveryMap({
  map,
  ...props
}: DeliveryMapProps & { readonly map: DeliveryLocatorSource['map'] }) {
  return map ? (
    <Suspense fallback={<MapLoading>{props.children}</MapLoading>}>
      <MapboxMap {...props} token={map.token} style={map.style} />
    </Suspense>
  ) : (
    <StubMap {...props} />
  );
}
