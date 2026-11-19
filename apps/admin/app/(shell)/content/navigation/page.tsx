import { getTranslations } from 'next-intl/server';
import { NavigationRoute } from '../../../../src/content/navigation/navigation-route.tsx';

export async function generateMetadata() {
  const t = await getTranslations('content');
  return { title: t('navigation.page-title') };
}

/** Content, Navigation tab: the buyer site's left menu and Browse drawer lists. */
export default function NavigationPage() {
  return NavigationRoute();
}
