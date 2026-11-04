'use client';

import { Badge, Icon } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import {
  directionOf,
  keyResult,
  nameOf,
  typeAhead,
  type TreeKey,
  type VisibleRow,
} from './tree-model.ts';
import type { CategoryStatus } from './types.ts';

const STATUS_TONE: Record<CategoryStatus, 'success' | 'neutral' | 'attention'> = {
  active: 'success',
  hidden: 'neutral',
  merged: 'attention',
  archived: 'neutral',
};
const NAV_KEYS = new Set<string>([
  'ArrowDown',
  'ArrowUp',
  'ArrowRight',
  'ArrowLeft',
  'Home',
  'End',
  '*',
]);

export interface CategoryTreeProps {
  readonly label: string;
  readonly list: readonly VisibleRow[];
  readonly locale: string;
  readonly selectedId: string | null;
  /** The count of live products, already worded ("12" or "at least 12"). */
  readonly countText: (liveProducts: number) => string;
  readonly onSelect: (id: string) => void;
  readonly onExpand: (id: string, open: boolean) => void;
  readonly onExpandSiblings: (id: string) => void;
}

/**
 * The category tree as a WAI-ARIA tree: one tab stop (the focused row), arrows move, Right and Left
 * open and close, Home and End jump, `*` opens the siblings, typing jumps to a name, Enter or
 * Space picks the row. A name is text an admin entered and is rendered as plain text.
 */
export function CategoryTree({
  label,
  list,
  locale,
  selectedId,
  countText,
  onSelect,
  onExpand,
  onExpandSiblings,
}: CategoryTreeProps) {
  const t = useTranslations('categories');
  const [focusId, setFocusId] = useState<string | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const root = useRef<HTMLUListElement>(null);
  const moveDom = useRef(false);

  // The one tab stop: the focused row, else the selected one, else the first.
  const tabStop =
    [focusId, selectedId].find((id) => id !== null && list.some((e) => e.row.id === id)) ??
    list[0]?.row.id ??
    null;

  // A filter or a search can remove the row that has focus; the browser then drops focus to the
  // page. Keep it in the tree: the row that took its place in the list, else the last one.
  const lastList = useRef<readonly VisibleRow[]>(list);
  const inside = useRef(false);
  useEffect(() => {
    const before = lastList.current;
    lastList.current = list;
    if (focusId === null || list.some((entry) => entry.row.id === focusId)) return;
    const index = before.findIndex((entry) => entry.row.id === focusId);
    const next = list[Math.min(Math.max(index, 0), list.length - 1)];
    if (next === undefined) return;
    if (inside.current && document.activeElement === document.body) moveDom.current = true;
    setFocusId(next.row.id);
  }, [list, focusId]);

  useEffect(() => {
    if (!moveDom.current || focusId === null) return;
    // The row to focus is not in the list yet (or any more): keep the wish for the next pass.
    if (!list.some((entry) => entry.row.id === focusId)) return;
    moveDom.current = false;
    root.current?.querySelector<HTMLElement>(`[data-row-id="${focusId}"]`)?.focus();
  }, [focusId, list]);

  function onKeyDown(event: React.KeyboardEvent<HTMLLIElement>, id: string) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey)
      return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(id);
      return;
    }
    if (NAV_KEYS.has(event.key)) {
      event.preventDefault();
      const result = keyResult(list, id, event.key as TreeKey);
      if (result.kind === 'focus') {
        moveDom.current = true;
        setFocusId(result.id);
      } else if (result.kind === 'expand') onExpand(id, true);
      else if (result.kind === 'collapse') onExpand(id, false);
      else if (result.kind === 'expand-siblings') onExpandSiblings(id);
      return;
    }
    if (event.key.length === 1) {
      const now = Date.now();
      const text = (now - typed.current.at > 700 ? '' : typed.current.text) + event.key;
      typed.current = { text, at: now };
      const hit = typeAhead(list, id, text, locale);
      if (hit !== null) {
        moveDom.current = true;
        setFocusId(hit);
      }
    }
  }

  const direction = directionOf(locale);
  return (
    <ul ref={root} role="tree" aria-label={label} className="m-0 list-none p-0">
      {list.map(({ row, hasChildren, expanded, posInSet, setSize }) => {
        const name = nameOf(row, locale);
        const selected = row.id === selectedId;
        return (
          <li
            key={row.id}
            role="treeitem"
            data-row-id={row.id}
            aria-level={row.depth + 1}
            aria-posinset={posInSet}
            aria-setsize={setSize}
            aria-selected={selected}
            {...(hasChildren ? { 'aria-expanded': expanded } : {})}
            tabIndex={row.id === tabStop ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, row.id)}
            onFocus={(event) => {
              inside.current = true;
              if (event.target === event.currentTarget) setFocusId(row.id);
            }}
            onBlur={(event) => {
              // Focus going to something outside the tree ends "focus is in the tree".
              if (!root.current?.contains(event.relatedTarget)) {
                inside.current = event.relatedTarget === null;
              }
            }}
            onClick={() => onSelect(row.id)}
            style={{ paddingInlineStart: `${row.depth * 1.25 + 0.5}rem` }}
            className={[
              'flex min-h-11 cursor-pointer items-center gap-2 border-b border-line py-1 pe-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
              selected ? 'bg-selected font-medium' : 'hover:bg-muted',
            ].join(' ')}
          >
            {hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                // 44 px to hit, 24 px of layout (the row is the keyboard target; this is for the pointer).
                className="-mx-2.5 flex size-11 shrink-0 items-center justify-center rounded text-icon"
                onClick={(event) => {
                  event.stopPropagation();
                  onExpand(row.id, !expanded);
                }}
              >
                <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
              </button>
            ) : (
              <span aria-hidden="true" className="size-6 shrink-0" />
            )}
            <span
              dir={row.names.some((entry) => entry.locale === locale) ? direction : 'auto'}
              className="min-w-0 flex-1 truncate"
            >
              {name}
            </span>
            {row.status === 'active' ? null : (
              <Badge tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
            )}
            <span className="shrink-0 text-sm text-fg-muted">
              {countText(row.counts.liveProducts)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
