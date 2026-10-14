'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface BottomTab {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly active: boolean;
}

export interface AppShellProps {
  readonly sidebar: ReactNode;
  readonly topbar: ReactNode;
  readonly children: ReactNode;
  /** Texts of the phone navigation (the app resolves them from its catalogue). */
  readonly labels: { readonly menu: string; readonly close: string; readonly more: string };
  /** Seller only (panels IA 4): tabs of the phone bottom bar; "More" is added by the shell. */
  readonly bottomTabs?: readonly BottomTab[];
  /** True when none of the tabs is active, so "More" shows as the active one. */
  readonly moreActive?: boolean;
}

function MenuIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
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
            <MenuIcon />
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
            <span aria-hidden="true" className="text-xl leading-none">
              ×
            </span>
          </button>
          {open ? sidebar : null}
        </div>
      </dialog>
      {hasBar ? (
        <nav
          aria-label={labels.menu}
          className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {bottomTabs.map((tab) => (
            <a
              key={tab.id}
              href={tab.href}
              aria-current={tab.active ? 'page' : undefined}
              className={`flex min-h-16 flex-1 items-center justify-center px-2 text-sm font-medium ${tab.active ? 'text-accent' : 'text-fg-secondary'}`}
            >
              {tab.label}
            </a>
          ))}
          <button
            type="button"
            aria-expanded={open}
            aria-current={moreActive === true || open ? 'page' : undefined}
            onClick={() => setOpen(true)}
            className={`flex min-h-16 flex-1 items-center justify-center px-2 text-sm font-medium ${moreActive === true || open ? 'text-accent' : 'text-fg-secondary'}`}
          >
            {labels.more}
          </button>
        </nav>
      ) : null}
    </div>
  );
}
