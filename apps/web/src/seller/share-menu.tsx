'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../icons/icon.tsx';

// The Share pill on the seller banner and its menu: Copy link, WhatsApp, Email and, where the
// browser has a share sheet, More options. Esc and an outside click close it; focus returns to the
// pill on Esc and after a channel is chosen. Arrow keys, Home and End move between the items.

export function ShareMenu({ name, path }: { readonly name: string; readonly path: string }) {
  const t = useTranslations('seller');
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState('');
  const [canShare, setCanShare] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // The page's own address and the share sheet exist only in the browser.
  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator.share === 'function');
  }, []);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onClick = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open]);

  const url = `${origin}${path}`;
  /** Closes the menu and returns focus to the pill (after Esc or a chosen channel). */
  function close() {
    setOpen(false);
    pill.current?.focus({ preventScroll: true });
  }
  const text = `${t('share-text', { name })} ${url}`;

  const toggle = () => {
    setCopied(false);
    setOpen((was) => !was);
  };
  const copy = () => {
    navigator.clipboard?.writeText(url).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  const more = () => {
    close();
    navigator.share({ title: name, text: t('share-text', { name }), url }).catch(() => undefined);
  };
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown'
        ? (at + 1) % items.length
        : event.key === 'ArrowUp'
          ? (at - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className="shop-share" ref={wrap}>
      <button
        type="button"
        ref={pill}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={toggle}
      >
        <Icon name="share" />
        {t('share')}
      </button>
      <div
        className="shop-share-menu"
        id={menuId}
        role="menu"
        aria-label={t('share-menu')}
        ref={menu}
        hidden={!open}
        onKeyDown={move}
      >
        <div className="shop-share-url" role="none">
          <Icon name="pin" />
          <span>{url.replace(/^https?:\/\//, '')}</span>
        </div>
        <button type="button" role="menuitem" onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} />
          {copied ? t('link-copied') : t('copy-link')}
        </button>
        <a
          role="menuitem"
          href={`https://wa.me/?text=${encodeURIComponent(text)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={close}
        >
          <Icon name="chat" />
          {t('whatsapp')}
        </a>
        <a
          role="menuitem"
          href={`mailto:?subject=${encodeURIComponent(t('share-subject', { name }))}&body=${encodeURIComponent(text)}`}
          onClick={close}
        >
          <Icon name="mail" />
          {t('email')}
        </a>
        {canShare ? (
          <button type="button" role="menuitem" onClick={more}>
            <Icon name="share" />
            {t('more-options')}
          </button>
        ) : null}
      </div>
      <span className="sr-only" role="status">
        {copied ? t('link-copied') : ''}
      </span>
    </div>
  );
}
