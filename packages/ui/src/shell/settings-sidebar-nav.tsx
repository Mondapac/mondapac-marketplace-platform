'use client';

import { useState, type KeyboardEvent } from 'react';
import { Icon } from '../icon/icon.tsx';
import { filterSettingsMenu, type SettingsMenu } from './settings-menu.ts';

const RAIL_HIDDEN = 'group-data-[rail=true]/rail:sr-only';
const ROW =
  'flex w-full items-center gap-(--mp-space-2-5) min-h-(--mp-size-control) rounded-md px-3 py-1 group-data-[rail=true]/rail:justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

/**
 * The sidebar inside /settings: "Back to Dashboard", a search field that filters the settings
 * links, then each group (a labelled group with its icon and name) with its links (the current
 * page marked). It sits
 * in the same column as the normal menu, so the rail and the phone drawer behave as before; on the
 * rail each group shows as its icon, linking to its first page.
 */
export function SettingsSidebarNav({ menu }: { readonly menu: SettingsMenu }) {
  const [query, setQuery] = useState('');
  const shown = filterSettingsMenu(menu.groups, query);
  const first = shown[0]?.links[0];

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && first !== undefined) {
      event.preventDefault();
      window.location.assign(first.href);
    } else if (event.key === 'Escape' && query !== '') {
      event.stopPropagation();
      setQuery('');
    }
  }

  return (
    <nav aria-label={menu.navLabel} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden p-3">
        <a href={menu.backHref} className={`${ROW} text-sm font-medium text-link hover:bg-muted`}>
          <Icon name="chevron-left" className="rtl:rotate-180" />
          <span className={`min-w-0 truncate ${RAIL_HIDDEN}`}>{menu.backLabel}</span>
        </a>
        <div className="group-data-[rail=true]/rail:hidden">
          <label className="relative block">
            <span className="sr-only">{menu.searchLabel}</span>
            <Icon
              name="search"
              className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-icon"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={menu.searchLabel}
              autoComplete="off"
              className="min-h-(--mp-size-control) w-full rounded-md border border-line-control bg-surface ps-9 pe-3 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-focus"
            />
          </label>
        </div>
        <div
          role="status"
          className={shown.length === 0 ? 'px-3 text-sm text-fg-muted' : 'sr-only'}
        >
          {shown.length === 0 ? menu.emptyLabel : ''}
        </div>
        {shown.map((group) => {
          const holdsActive = group.links.some((link) => link.id === menu.activeId);
          return (
            <div
              key={group.id}
              role="group"
              aria-labelledby={`settings-menu-group-${group.id}`}
              className="flex flex-col gap-1"
            >
              <p
                id={`settings-menu-group-${group.id}`}
                className="flex items-center gap-2 px-3 pt-1 text-sm font-semibold text-fg-secondary group-data-[rail=true]/rail:sr-only"
              >
                <Icon name={group.icon} className="text-icon" />
                <span className="min-w-0 break-words">{group.label}</span>
              </p>
              {/* Rail: the group is its icon, linking to its first page; the links wait for the peek. */}
              <a
                href={group.links[0]?.href}
                aria-label={group.label}
                tabIndex={-1}
                aria-hidden="true"
                className={`hidden ${ROW} hover:bg-muted group-data-[rail=true]/rail:flex ${
                  holdsActive ? 'bg-selected text-link' : 'text-icon'
                }`}
              >
                <Icon name={group.icon} />
              </a>
              <div className="flex flex-col gap-1 group-data-[rail=true]/rail:hidden">
                {group.links.map((link) => {
                  const active = link.id === menu.activeId;
                  return (
                    <a
                      key={link.id}
                      href={link.href}
                      aria-current={active ? 'page' : undefined}
                      className={`${ROW} text-sm ${
                        active
                          ? 'bg-selected font-medium text-link'
                          : 'text-fg-secondary hover:bg-muted hover:text-fg'
                      }`}
                    >
                      <span className="min-w-0 break-words">{link.label}</span>
                    </a>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
