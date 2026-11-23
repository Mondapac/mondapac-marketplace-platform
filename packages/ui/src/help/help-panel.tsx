'use client';

import { useEffect, useId, useRef } from 'react';
import { Icon } from '../icon/icon.tsx';
import { useHelp } from './help-context.tsx';

export interface HelpLink {
  readonly label: string;
  readonly href: string;
}

/** What the panel shows for one page. An empty section is not shown. */
export interface HelpContent {
  /** The page's name, for the heading "About <page>". */
  readonly page: string;
  /** What the page is for. */
  readonly about: string;
  /** Pages with section tabs: the open tab's own text. Changing tab changes only this. */
  readonly tab?: {
    readonly name: string;
    readonly text: string;
    readonly points?: readonly string[];
  };
  /** Short facts worth knowing before using the page. */
  readonly goodToKnow?: readonly string[];
  /** Links to other pages, opened in the same window. */
  readonly related?: readonly HelpLink[];
  /** Articles and videos; the whole section stays hidden until there are some. */
  readonly learnMore?: readonly HelpLink[];
}

export interface HelpPanelProps {
  readonly content: HelpContent | null;
  readonly labels: {
    /** Heading template parts: "About" then the page name. */
    readonly about: string;
    /** Before the tab's name: "This tab". */
    readonly thisTab: string;
    readonly goodToKnow: string;
    readonly related: string;
    readonly learnMore: string;
    readonly close: string;
  };
}

const SECTION = 'text-sm font-semibold text-fg';

function Links({ links }: { readonly links: readonly HelpLink[] }) {
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {links.map((link) => (
        <li key={link.href}>
          <a
            href={link.href}
            className="inline-flex min-h-11 items-center sm:min-h-8 text-sm text-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * The drawer the Help button opens, sized as the notices drawer is (420 px, 480 px from 1280 px,
 * the whole width on phones). It is an overlay at the inline-end edge below the top bar: it lies
 * on the page and never narrows it. It is non-modal, so the top bar stays reachable, and it stays
 * open while the user moves between tabs; its text follows `content`. A press outside it, Escape
 * or the close button closes it and gives focus back to the Help button.
 */
export function HelpPanel({ content, labels }: HelpPanelProps) {
  const { open, close, panelId } = useHelp();
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  if (!open || content === null) return null;

  const goodToKnow = content.goodToKnow ?? [];
  const related = content.related ?? [];
  const learnMore = content.learnMore ?? [];

  return (
    <aside
      ref={panel}
      id={panelId}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-y-0 end-0 z-40 flex w-full flex-col border-line bg-surface text-fg shadow-(--mp-shadow-elevation-floating) focus:outline-none sm:w-(--mp-size-sheet) sm:border-s xl:w-(--mp-size-sheet-wide) md:top-(--mp-size-topbar)"
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 id={titleId} className="min-w-0 flex-1 break-words text-lg font-semibold">
          {labels.about} {content.page}
        </h2>
        <button
          type="button"
          aria-label={labels.close}
          onClick={close}
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus "
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        <p className="text-sm text-fg">{content.about}</p>
        {content.tab === undefined ? null : (
          <section
            aria-label={`${labels.thisTab}: ${content.tab.name}`}
            className="border-s-4 border-accent ps-3"
          >
            <h3 className={SECTION}>
              {labels.thisTab}: {content.tab.name}
            </h3>
            <p className="mt-2 text-sm text-fg">{content.tab.text}</p>
            {(content.tab.points ?? []).length === 0 ? null : (
              <ul className="mt-2 flex list-disc flex-col gap-2 ps-5 text-sm text-fg">
                {content.tab.points?.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </section>
        )}
        {goodToKnow.length === 0 ? null : (
          <section>
            <h3 className={SECTION}>{labels.goodToKnow}</h3>
            <ul className="mt-2 flex list-disc flex-col gap-2 ps-5 text-sm text-fg">
              {goodToKnow.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}
        {related.length === 0 ? null : (
          <section>
            <h3 className={SECTION}>{labels.related}</h3>
            <Links links={related} />
          </section>
        )}
        {learnMore.length === 0 ? null : (
          <section>
            <h3 className={SECTION}>{labels.learnMore}</h3>
            <Links links={learnMore} />
          </section>
        )}
      </div>
    </aside>
  );
}
