'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';

// The right-hand filters drawer the product listing and the sellers page share (listing prototype
// v7): 380px, a dialog that Esc and the scrim close, with focus going back to the button that
// opened it. Its open state is the store context's `filtersOpen`.

export function FiltersDrawerFrame({
  pending,
  footer,
  children,
}: {
  /** True while the page loads the new filters; the groups show it as busy. */
  readonly pending: boolean;
  readonly footer: ReactNode;
  readonly children: ReactNode;
}) {
  const t = useTranslations('catalog');
  const { filtersOpen: open, setFiltersOpen } = useStore();
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => setMounted(true), []);
  // Leaving the page closes the drawer, so it never stays open over another page.
  useEffect(() => () => setFiltersOpen(false), [setFiltersOpen]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    panel.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFiltersOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener.current instanceof HTMLElement) opener.current.focus({ preventScroll: true });
    };
  }, [open, setFiltersOpen]);

  const close = () => setFiltersOpen(false);

  if (!mounted) return null;
  return createPortal(
    <div className={open ? 'fwrap open' : 'fwrap'}>
      <div className="fscrim" onClick={close} />
      <aside
        className="fpanel"
        id="filters-panel"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="filters-title"
        inert={!open}
      >
        <div className="phd">
          <h2 id="filters-title">{t('filters')}</h2>
          <button className="iconbtn" type="button" aria-label={t('close-filters')} onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div className="fb" aria-busy={pending}>
          {children}
        </div>
        <div className="ff">{footer}</div>
      </aside>
    </div>,
    document.body,
  );
}

export function FilterGroupView({
  title,
  open = false,
  children,
}: {
  readonly title: string;
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details className="fg" open={open}>
      <summary>
        {title}
        <Icon name="chevd" />
      </summary>
      <div className="opts">{children}</div>
    </details>
  );
}

/** One checkbox of a group with its count; an option with nothing in it cannot be ticked. */
export function FilterOption({
  label,
  count,
  on,
  onChange,
}: {
  readonly label: string;
  readonly count: number;
  readonly on: boolean;
  readonly onChange: () => void;
}) {
  // A ticked option can always go, so a filter in use is never stuck.
  return (
    <label className="opt">
      <input type="checkbox" checked={on} disabled={count === 0 && !on} onChange={onChange} />
      <span>{label}</span>
      <small className="num">{count}</small>
    </label>
  );
}
