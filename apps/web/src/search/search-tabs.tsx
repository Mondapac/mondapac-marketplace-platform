'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type ResultTab = 'products' | 'stores';

const TABS: readonly ResultTab[] = ['products', 'stores'];

/**
 * Products and Stores as an ARIA tablist (arrow keys, Home and End move between the tabs). Both
 * panels are rendered on the server; the chosen tab goes into the URL (`tab=stores`) without a
 * reload, so a shared link opens the same tab.
 */
export function SearchTabs({
  initial,
  counts,
  panels,
}: {
  readonly initial: ResultTab;
  readonly counts: Readonly<Record<ResultTab, number>>;
  readonly panels: Readonly<Record<ResultTab, ReactNode>>;
}) {
  const t = useTranslations('search-results');
  const [tab, setTab] = useState(initial);
  const buttons = useRef<Partial<Record<ResultTab, HTMLButtonElement | null>>>({});

  const choose = (next: ResultTab, focus = false) => {
    setTab(next);
    if (focus) buttons.current[next]?.focus();
    const url = new URL(window.location.href);
    if (next === 'stores') url.searchParams.set('tab', 'stores');
    else url.searchParams.delete('tab');
    window.history.replaceState(window.history.state, '', url);
  };

  const onKey = (event: KeyboardEvent) => {
    const at = TABS.indexOf(tab);
    const to: Record<string, number> = {
      ArrowRight: (at + 1) % TABS.length,
      ArrowLeft: (at + TABS.length - 1) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    const index = to[event.key];
    if (index === undefined) return;
    event.preventDefault();
    choose(TABS[index]!, true);
  };

  return (
    <>
      <div className="sr-tabs" role="tablist" aria-label={t('tabs')} onKeyDown={onKey}>
        {TABS.map((id) => (
          <button
            key={id}
            ref={(el) => {
              buttons.current[id] = el;
            }}
            id={`sr-tab-${id}`}
            role="tab"
            type="button"
            aria-selected={tab === id}
            aria-controls={`sr-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => choose(id)}
          >
            {t(id)}
            <span className="num">{t('tab-count', { count: counts[id] })}</span>
          </button>
        ))}
      </div>
      {TABS.map((id) => (
        <div
          key={id}
          id={`sr-panel-${id}`}
          className="sr-panel"
          role="tabpanel"
          aria-labelledby={`sr-tab-${id}`}
          hidden={tab !== id}
        >
          {panels[id]}
        </div>
      ))}
    </>
  );
}
