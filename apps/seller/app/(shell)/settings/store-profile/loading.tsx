import { RouteLoading, SIDEBAR_COOKIE, sidebarCollapsed } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

/**
 * Shown while the Store profile tab loads: the shell frame and the placeholder cards, with the
 * page's own label for screen readers ("Loading the store profile").
 */
export default async function Loading() {
  const t = await getTranslations();
  const collapsed = sidebarCollapsed((await cookies()).get(SIDEBAR_COOKIE)?.value);
  return <RouteLoading label={t('store-profile.loading')} collapsed={collapsed} />;
}
