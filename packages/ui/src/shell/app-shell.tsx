'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';

export interface BottomTab {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly active: boolean;
}

export interface AppShellProps {
  readonly sidebar: ReactNode;
  readonly topbar: ReactNode;
  readonly children: ReactNode;
  /** Texts of the phone navigation (the app resolves them from its catalogue). */
  readonly labels: {
    readonly menu: string;
    readonly close: string;
    readonly more: string;
    /** Name of the bottom bar landmark. */
    readonly main: string;
  };
  /** Seller only (panels IA 4): tabs of the phone bottom bar; "More" is added by the shell. */
  readonly bottomTabs?: readonly BottomTab[];
  /** True when none of the tabs is active, so "More" shows as the active one. */
  readonly moreActive?: boolean;
}

/**
 * The one shell of both panels (kickoff 2, panels IA 4). From 760 px the sidebar is a column;
 * below it the same sidebar opens as a drawer from the menu button (and, for the seller, from
 * "More" in the bottom bar). There is no icon rail on phones (D16, IA 4.1).
 */
export function AppShell({
  sidebar,
  topbar,
  children,
  labels,
  bottomTabs,
  moreActive,
}: AppShellProps) {
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const hasBar = bottomTabs !== undefined && bottomTabs.length > 0;

  useEffect(() => {
    const dialog = drawer.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    // The drawer is a phone control: widening the window past 760 px closes it.
    const query = window.matchMedia('(min-width: 760px)');
    const close = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    query.addEventListener('change', close);
    return () => query.removeEventListener('change', close);
  }, []);

  return (
    <div className="grid min-h-screen grid-cols-1 bg-page md:grid-cols-[var(--mp-size-sidebar)_minmax(0,1fr)]">
      <aside className="hidden flex-col border-e border-line bg-surface md:flex">{sidebar}</aside>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-stretch border-b border-line bg-surface">
          <button
            type="button"
            aria-label={labels.menu}
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="flex min-h-12 min-w-12 items-center justify-center text-fg md:hidden"
          >
            <Icon name="menu" />
          </button>
          <div className="min-w-0 flex-1">{topbar}</div>
        </div>
        <main className={`min-w-0 flex-1 p-4 sm:p-6 ${hasBar ? 'pb-24 md:pb-6' : ''}`}>
          {children}
        </main>
      </div>
      <dialog
        ref={drawer}
        aria-label={labels.menu}
        data-density="touch"
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClick={(event) => {
          // A click on the backdrop targets the dialog element itself; the panel inside fills it.
          if (event.target === drawer.current) setOpen(false);
        }}
        className="m-0 h-full max-h-none w-[min(20rem,85vw)] max-w-none bg-transparent p-0 text-fg backdrop:bg-scrim md:hidden"
      >
        <div className="relative flex h-full flex-col bg-surface">
          <button
            type="button"
            aria-label={labels.close}
            onClick={() => setOpen(false)}
            className="absolute end-1 top-1 flex min-h-12 min-w-12 items-center justify-center text-fg-secondary"
          >
            <Icon name="x" />
          </button>
          {open ? sidebar : null}
        </div>
      </dialog>
      {hasBar ? (
        <nav
          aria-label={labels.main}
          className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {bottomTabs.map((tab) => (
            <a
              key={tab.id}
              href={tab.href}
              aria-current={tab.active ? 'page' : undefined}
              className={`flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2 text-xs font-medium ${tab.active ? 'text-link' : 'text-fg-secondary'}`}
            >
              <Icon name={tab.icon} />
              <span className="max-w-full text-center leading-tight">{tab.label}</span>
            </a>
          ))}
          <button
            type="button"
            aria-expanded={open}
            aria-current={moreActive === true || open ? 'page' : undefined}
            onClick={() => setOpen(true)}
            className={`flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2 text-xs font-medium ${moreActive === true || open ? 'text-link' : 'text-fg-secondary'}`}
          >
            <Icon name="menu" />
            <span className="max-w-full text-center leading-tight">{labels.more}</span>
          </button>
        </nav>
      ) : null}
    </div>
  );
}
