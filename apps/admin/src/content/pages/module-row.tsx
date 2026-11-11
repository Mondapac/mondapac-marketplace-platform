'use client';

import { Badge, Button, IconButton, Menu, Switch } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { isEditableModule } from './module-schema.ts';
import { summaryOf } from './module-summary.ts';
import type { Placement } from './page-types.ts';

/**
 * One module of a slot: its name and a line that tells it apart, then (with the edit key) move
 * up and down, the show/hide switch, Edit and More (Remove). Every action writes the draft.
 */
export function ModuleRow({
  placement,
  index,
  count,
  min,
  editable,
  busy,
  onMove,
  onToggle,
  onEdit,
  onRemove,
}: {
  readonly placement: Placement;
  readonly index: number;
  readonly count: number;
  /** The slot's minimum: Remove is off when the slot is at it. */
  readonly min: number;
  /** False: the page is read-only and the row has no controls. */
  readonly editable: boolean;
  /** A change is being saved: the controls wait. */
  readonly busy: boolean;
  readonly onMove: (by: -1 | 1) => void;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations('content.pages.editor');
  const names = useTranslations('content.pages.editor.module');
  const name = names.has(placement.module) ? names(placement.module) : placement.module;
  const say = (key: string, values?: Record<string, string | number>): string =>
    t.has(key) ? t(key, values) : key.replace(/^source-name-/u, '');
  const summary = summaryOf(placement, say);
  const canEditModule = isEditableModule(placement.module);
  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-line bg-surface p-3 ${
        placement.enabled ? '' : 'bg-muted/60'
      }`}
    >
      <div className="min-w-0 flex-1 basis-48">
        <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
          <span className="break-words">{name}</span>
          {placement.enabled ? null : <Badge tone="neutral">{t('hidden')}</Badge>}
        </p>
        {summary === '' ? null : <p className="break-words text-sm text-fg-muted">{summary}</p>}
      </div>
      {editable ? (
        <div className="flex flex-wrap items-center gap-1">
          <IconButton
            icon="chevron-up"
            label={t('tools.up', { name })}
            disabled={busy || index === 0}
            data-move={`${placement.id}:-1`}
            onClick={() => onMove(-1)}
          />
          <IconButton
            icon="chevron-down"
            label={t('tools.down', { name })}
            disabled={busy || index === count - 1}
            data-move={`${placement.id}:1`}
            onClick={() => onMove(1)}
          />
          <Switch
            checked={placement.enabled}
            disabled={busy}
            aria-label={t('show-switch', { name })}
            onCheckedChange={onToggle}
          />
          {canEditModule ? (
            <Button variant="secondary" disabled={busy} onClick={onEdit}>
              {t('edit')}
              <span className="sr-only"> {name}</span>
            </Button>
          ) : null}
          <Menu
            label={t('more', { name })}
            items={[
              {
                id: 'remove',
                label: t('remove'),
                icon: 'trash',
                tone: 'critical',
                disabled: busy || count <= min,
                ...(count <= min ? { reason: t('remove-min', { min }) } : {}),
                onSelect: onRemove,
              },
            ]}
          />
        </div>
      ) : null}
    </li>
  );
}
