'use client';

import { Tabs, PageHeader } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ListPagingMode } from '../shared/paged-list/types.ts';
import { SuggestionsList } from './suggestions-list.tsx';
import { SUGGESTIONS_PATH } from './suggestion-types.ts';
import { TAGS_PATH } from './types.ts';

/**
 * The queue of tag suggestions from sellers (product tags T5b) as a super list, beside the Tags
 * list. Nothing is decided by itself; every decision names the version the admin saw.
 */
export function SuggestionsView({
  csrfToken,
  paging,
  accountId,
  marketId,
  zone,
}: {
  readonly csrfToken: string;
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the Requested presets. */
  readonly zone: string;
}) {
  const t = useTranslations('tags.suggestions');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('title')} />
      <Tabs
        label={t('tabs')}
        activeId="suggestions"
        items={[
          { id: 'tags', label: t('tab.tags'), href: TAGS_PATH },
          { id: 'suggestions', label: t('tab.suggestions'), href: SUGGESTIONS_PATH },
        ]}
      />
      <SuggestionsList
        paging={paging}
        accountId={accountId}
        marketId={marketId}
        zone={zone}
        csrfToken={csrfToken}
      />
    </div>
  );
}
