import type { SearchSelectLabels } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

/** The searchable dropdown's own words, from the page's messages. */
export function useSelectLabels(): Partial<SearchSelectLabels> {
  const t = useTranslations('attributes.select');
  return {
    search: t('search'),
    noResults: t('no-results'),
    loading: t('loading'),
    retry: t('retry'),
    remove: (name) => t('remove', { name }),
    limitReached: (max) => t('limit', { max }),
    none: t('none'),
  };
}
