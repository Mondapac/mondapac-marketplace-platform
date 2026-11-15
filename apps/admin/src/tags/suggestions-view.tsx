'use client';

import { Banner, EmptyState, LoadError, SkeletonRows, Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { SuggestionCard } from './suggestion-card.tsx';
import {
  API_TOPIC_SUGGESTIONS,
  SUGGESTIONS_PATH,
  type SuggestionList,
} from './suggestion-types.ts';
import { TAGS_PATH } from './types.ts';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: SuggestionList }
  | { readonly state: 'denied' }
  | { readonly state: 'failed' };

/** The language in words, with the code as the fallback. */
function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/**
 * The queue of tag suggestions from sellers (product tags T5b): the whole open queue, oldest
 * first, each with Approve, Map to existing tag and Reject. The seller's words are plain text.
 * Nothing is decided by itself; every decision names the version the admin saw.
 */
export function SuggestionsView({
  canApprove,
  csrfToken,
  noAccess,
}: {
  readonly canApprove: boolean;
  readonly csrfToken: string;
  /** Shown when the read is refused (403): the page then hides like the attributes tab does. */
  readonly noAccess: React.ReactNode;
}) {
  const t = useTranslations('tags.suggestions');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // The position of the card just decided: focus goes to the card now at that place.
  const focusAt = useRef<number | null>(null);

  const fetchList = useCallback(async (quiet = false) => {
    if (!quiet) setLoad({ state: 'loading' });
    const result = await callApi<SuggestionList>('GET', API_TOPIC_SUGGESTIONS);
    if (result.ok) {
      setLoad({ state: 'ready', value: result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (quiet) {
      setNotice('reload-failed');
      return;
    }
    setLoad({ state: result.failure.status === 403 ? 'denied' : 'failed' });
  }, []);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  useEffect(() => {
    if (load.state !== 'ready' || focusAt.current === null) return;
    const index = focusAt.current;
    focusAt.current = null;
    const buttons = list.current?.querySelectorAll<HTMLElement>('li > section');
    const target =
      load.value.items.length === 0
        ? list.current
        : (buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)]?.querySelector<HTMLElement>(
            'button',
          ) ?? null);
    target?.focus();
  }, [load]);

  const count = load.state === 'ready' ? load.value.items.length : 0;
  const tabs = (
    <Tabs
      label={t('tabs')}
      activeId="suggestions"
      items={[
        { id: 'tags', label: t('tab.tags'), href: TAGS_PATH },
        {
          id: 'suggestions',
          label: count > 0 ? t('tab.suggestions-count', { count }) : t('tab.suggestions'),
          href: SUGGESTIONS_PATH,
        },
      ]}
    />
  );

  if (load.state === 'denied') return <>{noAccess}</>;

  let body: React.ReactNode;
  if (load.state === 'loading') {
    body = <SkeletonRows label={t('loading')} rows={3} />;
  } else if (load.state === 'failed') {
    body = (
      <LoadError
        message={t('load-failed')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchList()}
      />
    );
  } else {
    const { items, locales } = load.value;
    const banner =
      notice === null ? null : (
        <div role="alert">
          <Banner tone="info">
            {t(`notice.${notice}`)}
            {notice === 'reload-failed' ? (
              <>
                {' '}
                <button
                  type="button"
                  className="font-medium text-link underline"
                  onClick={() => void fetchList(true)}
                >
                  {tl('retry')}
                </button>
              </>
            ) : null}
          </Banner>
        </div>
      );
    body = (
      <div ref={list} tabIndex={-1} className="flex flex-col gap-4 outline-none">
        {banner}
        {items.length === 0 ? (
          <EmptyState size="card" icon="inbox" title={t('empty')} body={t('empty-body')} />
        ) : (
          <ul className="flex flex-col gap-4" aria-label={t('list-label')}>
            {items.map((item, index) => (
              <li key={`${item.id}:${item.version}`}>
                <SuggestionCard
                  item={item}
                  defaultLocale={locales.default}
                  languageLabel={languageName(locales.default)}
                  canApprove={canApprove}
                  csrfToken={csrfToken}
                  onSettled={(why) => {
                    setNotice(why ?? null);
                    focusAt.current = index;
                    void fetchList(true);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-fg">{t('title')}</h1>
        {count > 0 ? <p className="text-fg-muted">{t('waiting', { count })}</p> : null}
      </div>
      {tabs}
      <p className="max-w-prose text-fg-muted">{t('intro')}</p>
      {body}
    </div>
  );
}
