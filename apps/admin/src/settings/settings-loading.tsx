import {
  SettingsRouteLoading,
  SIDEBAR_COOKIE,
  sidebarCollapsed,
  type SkeletonSection,
} from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

/**
 * Panel loading L3: the body of a settings route's loading.tsx. The shell frame and the page's
 * form skeleton, shaped by its cards and their row counts; the label names the page
 * ("Loading Delivery settings").
 */
export async function SettingsLoading({
  titleKey,
  sections,
  subNav = true,
}: {
  /** The message key of the page's title. */
  readonly titleKey: string;
  readonly sections: readonly SkeletonSection[];
  /** False for a settings-style page outside /settings (no sub-navigation column). */
  readonly subNav?: boolean;
}) {
  const t = await getTranslations();
  const collapsed = sidebarCollapsed((await cookies()).get(SIDEBAR_COOKIE)?.value);
  return (
    <SettingsRouteLoading
      label={t('route.loading-page', { page: t(titleKey) })}
      collapsed={collapsed}
      subNav={subNav}
      sections={sections}
      slowLabel={t('route.slow')}
      stalled={{
        title: t('route.stalled.title'),
        message: t('route.stalled.message'),
        retryLabel: t('route.error.retry'),
      }}
    />
  );
}
