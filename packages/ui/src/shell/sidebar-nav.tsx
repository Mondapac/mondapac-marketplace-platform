'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';
import { NAV_OPEN_COOKIE, navOpenGroups } from './nav.ts';

export interface SidebarLink {
  readonly id: string;
  readonly href: string;
  readonly icon: IconName;
  readonly label: string;
}

/** A sidebar entry with its text already resolved: a plain link, or a group that folds links. */
export type SidebarEntry =
  | ({ readonly kind: 'item' } & SidebarLink)
  | {
      readonly kind: 'group';
      readonly id: string;
      readonly icon: IconName;
      readonly label: string;
      readonly items: readonly SidebarLink[];
    };

export interface SidebarNavProps {
  readonly panelName: string;
  readonly entries: readonly SidebarEntry[];
  /** Links pinned to the bottom of the sidebar (the Settings item), outside the scrolling menu. */
  readonly footer?: readonly SidebarLink[];
  readonly activeId: string;
  /** Ids of the open groups from the cookie (the server reads it), so the first paint is right. */
  readonly openGroups?: readonly string[];
  /** Labels of the button that opens or closes every group; it shows with two or more groups. */
  readonly expandAll?: string;
  readonly collapseAll?: string;
}

// Inside the shell's column the sidebar can be an icon rail (`data-rail` on the `rail` group):
// labels stay for screen readers and every icon sits on the rail's centre line.
const RAIL_HIDDEN = 'group-data-[rail=true]/rail:sr-only';
// Several instances can be mounted (column and phone drawer); a toggle tells the others.
const SYNC_EVENT = 'mp-nav-open-change';
const ROW =
  'flex w-full items-center gap-(--mp-space-2-5) min-h-(--mp-size-control) rounded-md px-3 py-1 group-data-[rail=true]/rail:justify-center';

function writeCookie(ids: readonly string[]) {
  document.cookie = `${NAV_OPEN_COOKIE}=${encodeURIComponent(ids.join(','))}; path=/; max-age=31536000; samesite=lax`;
}

function readCookie(): readonly string[] | undefined {
  const entry = document.cookie.split('; ').find((part) => part.startsWith(`${NAV_OPEN_COOKIE}=`));
  return entry === undefined ? undefined : navOpenGroups(entry.slice(NAV_OPEN_COOKIE.length + 1));
}

/**
 * The sidebar's tree. A group header only opens and closes its links (several groups can be open
 * at once); the links stay plain links. The open groups live in a cookie the server reads, and
 * the group holding the active page opens with the page.
 */
export function SidebarNav({
  panelName,
  entries,
  footer = [],
  activeId,
  openGroups = [],
  expandAll,
  collapseAll,
}: SidebarNavProps) {
  const groups = entries.flatMap((entry) => (entry.kind === 'group' ? [entry] : []));
  const groupIds = groups.map((group) => group.id);
  const activeGroup = groups.find((group) => group.items.some((item) => item.id === activeId))?.id;
  const [open, setOpen] = useState<readonly string[]>(() =>
    activeGroup === undefined || openGroups.includes(activeGroup)
      ? openGroups
      : [...openGroups, activeGroup],
  );
  const baseId = useId();
  const nav = useRef<HTMLElement>(null);
  // True after a press on a rail icon already opened its group, so the click that follows does not
  // toggle it back.
  const fromRail = useRef(false);

  // A drawer mounts after the page loaded: it takes the choice made since (the cookie).
  useEffect(() => {
    const saved = readCookie();
    if (saved !== undefined) {
      setOpen(
        activeGroup === undefined || saved.includes(activeGroup) ? saved : [...saved, activeGroup],
      );
    }
    const sync = () => {
      const next = readCookie();
      if (next !== undefined) setOpen(next);
    };
    window.addEventListener(SYNC_EVENT, sync);
    return () => window.removeEventListener(SYNC_EVENT, sync);
    // Once, on mount: a later page change is the next effect's job.
  }, []);

  // Moving to a page of another group opens that group.
  useEffect(() => {
    if (activeGroup === undefined) return;
    setOpen((current) => (current.includes(activeGroup) ? current : [...current, activeGroup]));
  }, [activeGroup]);

  function save(next: readonly string[]) {
    const ordered = groupIds.filter((id) => next.includes(id));
    setOpen(ordered);
    writeCookie(ordered);
    window.dispatchEvent(new Event(SYNC_EVENT));
  }

  function setGroup(id: string, value: boolean) {
    const without = open.filter((candidate) => candidate !== id);
    save(value ? [...without, id] : without);
  }

  const allOpen = groupIds.every((id) => open.includes(id));

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const root = nav.current;
    const target = event.target;
    if (root === null || !(target instanceof HTMLElement)) return;
    const stops = [...root.querySelectorAll<HTMLElement>('[data-nav-stop]')].filter(
      (stop) =>
        stop.closest('[hidden]') === null &&
        !(stop.dataset.navStop === 'link-in-group' && stop.closest('[data-rail="true"]') !== null),
    );
    const index = stops.indexOf(target);
    if (index === -1) return;
    const rtl = getComputedStyle(root).direction === 'rtl';
    const opens = rtl ? 'ArrowLeft' : 'ArrowRight';
    const closes = rtl ? 'ArrowRight' : 'ArrowLeft';
    const groupId = target.dataset.navGroup;
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = stops[Math.min(index + 1, stops.length - 1)];
    else if (event.key === 'ArrowUp') next = stops[Math.max(index - 1, 0)];
    else if (event.key === 'Home') next = stops[0];
    else if (event.key === 'End') next = stops[stops.length - 1];
    else if ((event.key === opens || event.key === closes) && groupId !== undefined) {
      setGroup(groupId, event.key === opens);
    } else return;
    event.preventDefault();
    next?.focus();
  }

  return (
    // The arrow keys are a shortcut on top of the buttons and links, which stay reachable by Tab.
    <nav
      ref={nav}
      aria-label={panelName}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden p-3">
        {groups.length >= 2 && expandAll !== undefined && collapseAll !== undefined ? (
          <button
            type="button"
            data-nav-stop="control"
            onClick={() => save(allOpen ? [] : groupIds)}
            className="mb-1 min-h-(--mp-size-control-sm) self-end rounded-md px-3 text-xs font-medium text-link hover:bg-muted md:min-h-8 group-data-[rail=true]/rail:invisible"
          >
            {allOpen ? collapseAll : expandAll}
          </button>
        ) : null}
        {entries.map((entry) => {
          if (entry.kind === 'item') {
            return (
              <NavLink key={entry.id} link={entry} active={entry.id === activeId} stop="link" />
            );
          }
          const isOpen = open.includes(entry.id);
          const listId = `${baseId}-${entry.id}`;
          return (
            <div key={entry.id} className="flex flex-col gap-1">
              <button
                type="button"
                data-nav-stop="header"
                data-nav-group={entry.id}
                aria-expanded={isOpen}
                aria-controls={listId}
                // A press on a rail icon opens the group at once: the press also widens the rail, so
                // the layout can move before the click lands.
                onPointerDown={(event) => {
                  fromRail.current = event.currentTarget.closest('[data-rail="true"]') !== null;
                  if (fromRail.current) setGroup(entry.id, true);
                }}
                onClick={() => {
                  if (fromRail.current) fromRail.current = false;
                  else setGroup(entry.id, !isOpen);
                }}
                // A closed group that holds the page keeps the link colour, so the place stays visible.
                className={`${ROW} text-start hover:bg-muted hover:text-fg ${
                  !isOpen && entry.id === activeGroup
                    ? 'font-medium text-link'
                    : 'text-fg-secondary'
                }`}
              >
                <Icon name={entry.icon} className="text-icon" />
                <span className={`min-w-0 flex-1 break-words ${RAIL_HIDDEN}`}>{entry.label}</span>
                <Icon
                  name="chevron-down"
                  className={`text-icon transition-transform motion-reduce:transition-none group-data-[rail=true]/rail:hidden ${isOpen ? '' : '-rotate-90 rtl:rotate-90'}`}
                />
              </button>
              {/* Closed links stay in the page (the header controls this list) but are hidden. On
                the rail a group is its icon only; its links show when the sidebar peeks open. */}
              <div id={listId} hidden={!isOpen} className="group-data-[rail=true]/rail:hidden">
                <div className="ms-5 flex flex-col gap-1 border-s border-line ps-2">
                  {entry.items.map((item) => (
                    <NavLink
                      key={item.id}
                      link={item}
                      active={item.id === activeId}
                      stop="link-in-group"
                    />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {footer.length === 0 ? null : (
        <div className="flex shrink-0 flex-col gap-1 border-t border-line p-3">
          {footer.map((link) => (
            <NavLink key={link.id} link={link} active={link.id === activeId} stop="link" />
          ))}
        </div>
      )}
    </nav>
  );
}

function NavLink({
  link,
  active,
  stop,
}: {
  readonly link: SidebarLink;
  readonly active: boolean;
  readonly stop: 'link' | 'link-in-group';
}) {
  return (
    <a
      href={link.href}
      data-nav-stop={stop}
      aria-current={active ? 'page' : undefined}
      className={`${ROW} ${
        active
          ? 'bg-selected font-medium text-link'
          : 'text-fg-secondary hover:bg-muted hover:text-fg'
      }`}
    >
      <Icon name={link.icon} className={active ? undefined : 'text-icon'} />
      <span className={`min-w-0 break-words md:truncate ${RAIL_HIDDEN}`}>{link.label}</span>
    </a>
  );
}
