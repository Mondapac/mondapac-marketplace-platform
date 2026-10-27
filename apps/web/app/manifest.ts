import type { MetadataRoute } from 'next';
import { getTranslations } from 'next-intl/server';
import { BACKGROUND_COLOR, ICONS, THEME_COLOR } from '../src/pwa/pwa-config.ts';

/**
 * The web app manifest (PWA level: installable shell plus an offline page, no offline data).
 * The name is the store title from messages, never a literal. start_url carries no source
 * parameter: analytics need consent (src/consent) and an install launch has no consent decision
 * to read, so the plain "/" is used.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await getTranslations('store');
  const name = t('title');
  return {
    name,
    short_name: name,
    description: t('description'),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [
      { src: ICONS.small, sizes: '192x192', type: 'image/png' },
      { src: ICONS.large, sizes: '512x512', type: 'image/png' },
      { src: ICONS.maskable, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: ICONS.apple, sizes: '180x180', type: 'image/png' },
    ],
  };
}
