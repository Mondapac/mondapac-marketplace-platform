'use client';

import { NavigationProgress } from '@mondapac/ui';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function RouteProgress() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? '';
  // No announcement here: each page's own loading state carries the one role="status".
  return <NavigationProgress route={`${pathname}?${search}`} />;
}

/**
 * Panel loading L1: the 2 px bar at the very top while a page navigation is on its way. Mounted
 * once in the panel shell. In a Suspense boundary of its own because it reads the query string.
 */
export function PanelNavigationProgress() {
  return (
    <Suspense fallback={null}>
      <RouteProgress />
    </Suspense>
  );
}
