'use client';

import { NavigationProgress as Bar } from '@mondapac/ui/navigation-progress';
import { useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';

export {
  PROGRESS_DELAY_MS,
  PROGRESS_GIVE_UP_MS,
  navigationTarget,
} from '@mondapac/ui/navigation-progress';

/**
 * The thin bar along the top of the page while a soft navigation is on its way (SEO package 5,
 * follow-up 2): the product and store routes have no loading boundary, because their 404 must be
 * decided before any HTML, so without it a tap on a card gives no sign until the page appears.
 * The bar itself lives in @mondapac/ui (panel loading L1, shared with both panels); here it gets
 * the route from the router, the "Loading" announcement, and the storefront's own 3 px teal look
 * (globals.css), unchanged.
 */
export function NavigationProgress() {
  const t = useTranslations('route');
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? '';
  return (
    <Bar
      route={`${pathname}?${search}`}
      label={t('loading')}
      className="nav-progress"
      barClassName="nav-progress-bar"
    />
  );
}
