'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CategoryArt } from '../icons/category-icon.tsx';
import { Icon } from '../icons/icon.tsx';
import type { Category } from '../storefront/types.ts';
import { useStore } from './store-context.tsx';

/** "Browse products": a 360px panel that slides over the page, two levels deep. */
export function BrowsePanel({ categories }: { readonly categories: readonly Category[] }) {
  const t = useTranslations('browse');
  const { browseOpen, setBrowseOpen } = useStore();
  const [current, setCurrent] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const category = categories.find((c) => c.code === current);

  useEffect(() => {
    if (!browseOpen) return;
    opener.current = document.activeElement;
    panel.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBrowseOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      setCurrent(null);
      if (opener.current instanceof HTMLElement) opener.current.focus({ preventScroll: true });
    };
  }, [browseOpen, setBrowseOpen]);

  useEffect(() => {
    if (browseOpen)
      panel.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [current, browseOpen]);

  const close = () => setBrowseOpen(false);
  const closeButton = (
    <button className="iconbtn" type="button" aria-label={t('close')} onClick={close}>
      <Icon name="close" />
    </button>
  );

  return (
    <div className={browseOpen ? 'pwrap open' : 'pwrap'}>
      <div className="scrim" onClick={close} />
      <div
        className="panel"
        id="browse-panel"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={category ? category.name : t('title')}
        inert={!browseOpen}
      >
        {category ? (
          <>
            <div className="phd">
              <button
                className="iconbtn bk"
                type="button"
                aria-label={t('back')}
                onClick={() => setCurrent(null)}
              >
                <Icon name="chevl" />
              </button>
              <h2>{category.name}</h2>
              {closeButton}
            </div>
            <div className="pb">
              <Link className="prow sub all" href={`/c/${category.code}`} onClick={close}>
                {t('see-all', { name: category.name.toLowerCase() })}
                <span className="rt">
                  <Icon name="chevr" />
                </span>
              </Link>
              {category.children.map((child) => (
                <Link
                  key={child.code}
                  className="prow sub"
                  href={`/c/${category.code}/${child.code}`}
                  onClick={close}
                >
                  {child.name}
                  <span className="rt">
                    <Icon name="chevr" />
                  </span>
                </Link>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="phd">
              <h2>{t('title')}</h2>
              {closeButton}
            </div>
            <div className="pb">
              <div className="pl">{t('popular')}</div>
              <div className="pchips">
                <Link href="/offers" onClick={close}>
                  <Icon name="tag" />
                  {t('specials')}
                </Link>
                <Link href="/best-sellers" onClick={close}>
                  <Icon name="bolt" />
                  {t('best-sellers')}
                </Link>
                <Link href="/new" onClick={close}>
                  <Icon name="leaf" />
                  {t('new')}
                </Link>
                <Link href="/certified" onClick={close}>
                  <Icon name="store" />
                  {t('certified')}
                </Link>
              </div>
              <div className="pl">{t('by-category')}</div>
              {categories.map((c) => (
                <button
                  key={c.code}
                  className="prow"
                  type="button"
                  onClick={() => setCurrent(c.code)}
                >
                  <span className="tl">
                    <CategoryArt code={c.code} />
                  </span>
                  {c.name}
                  <span className="rt">
                    <Icon name="chevr" />
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
