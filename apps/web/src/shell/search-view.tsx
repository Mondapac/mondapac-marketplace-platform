'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Icon } from '../icons/icon.tsx';
import { useSearchSubmit } from '../search/search-focus.tsx';
import { useStore } from './store-context.tsx';

/** The full-screen search of the phone and tablet layout. */
export function SearchView({ popular }: { readonly popular: readonly string[] }) {
  const t = useTranslations('search');
  const placeholder = useTranslations('header')('search-placeholder');
  const { searchOpen, setSearchOpen } = useStore();
  const input = useRef<HTMLInputElement>(null);
  // Enter or the keyboard's Search key: the panel closes and focus lands on the results heading.
  const onSearch = useSearchSubmit(() => setSearchOpen(false));

  useEffect(() => {
    if (!searchOpen) return;
    const opener = document.activeElement;
    input.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSearchOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement) opener.focus({ preventScroll: true });
    };
  }, [searchOpen, setSearchOpen]);

  return (
    <div
      className="sview"
      role="dialog"
      aria-modal="true"
      aria-label={t('dialog')}
      hidden={!searchOpen}
    >
      <form className="sform" role="search" action="/search" onSubmit={onSearch}>
        <button
          className="iconbtn"
          type="button"
          aria-label={t('close')}
          onClick={() => setSearchOpen(false)}
        >
          <Icon name="chevl" />
        </button>
        <label className="sin">
          <Icon name="search" />
          <input
            ref={input}
            type="search"
            name="q"
            placeholder={placeholder}
            aria-label={t('input')}
            maxLength={100}
            enterKeyHint="search"
          />
        </label>
      </form>
      <div className="sbody">
        <h2>{t('recent')}</h2>
        <p className="hint">{t('no-recent')}</p>
        {popular.length > 0 ? (
          <>
            <h2>{t('popular')}</h2>
            <div className="pchips">
              {popular.map((term) => (
                <Link
                  key={term}
                  href={`/search?q=${encodeURIComponent(term)}`}
                  onClick={() => setSearchOpen(false)}
                >
                  {term}
                </Link>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
