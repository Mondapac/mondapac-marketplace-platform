'use client';

import { ActionMenu, Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ModuleEditDialog } from './module-edit-dialog.tsx';
import { ModuleRow } from './module-row.tsx';
import { PageActions } from './page-actions.tsx';
import { isEditableModule, moved } from './module-schema.ts';
import { PageEditorHeader } from './page-editor-header.tsx';
import {
  detailRef,
  isReadOnlyPage,
  modulePath,
  slotModulesPath,
  slotOrderPath,
  type PageDetail,
  type Placement,
  type SlotDefinition,
} from './page-types.ts';
import { STALE_CODES, usePageCommand, useProblemText } from './use-page-command.ts';

type Editing = {
  readonly slot: string;
  readonly module: string;
  /** The module being changed; null: a module being added. */
  readonly placement: Placement | null;
};

/**
 * The Content tab of the page editor: the slots of the page's template in order, and in each the
 * modules the draft holds. Without the edit key (or on an archived or locked page) it only shows
 * them. Every change is written to the draft at once; buyers see nothing until it is published.
 */
export function PageContent({
  page: initial,
  canEdit,
  canPublish = false,
  canArchive = false,
  csrfToken,
  zone,
}: {
  readonly page: PageDetail;
  readonly canEdit: boolean;
  readonly canPublish?: boolean;
  readonly canArchive?: boolean;
  readonly csrfToken: string;
  readonly zone: string;
}) {
  const t = useTranslations('content.pages.editor');
  const names = useTranslations('content.pages.editor.module');
  const slotNames = useTranslations('content.pages.editor.slot');
  const router = useRouter();
  const problemText = useProblemText();
  const command = usePageCommand(csrfToken);
  const [page, setPage] = useState(initial);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<{ slot: string; placement: Placement } | null>(null);
  const [saved, setSaved] = useState(false);
  const focusAfter = useRef<string | null>(null);

  const readOnly = isReadOnlyPage(page, canEdit);
  const ref = detailRef(page);
  const moduleName = (key: string): string => (names.has(key) ? names(key) : key);

  // After a move the row's button is a new element; focus goes back to it (or to the other arrow
  // when the row reached the end of the slot), so the next press can follow at once.
  useEffect(() => {
    const wanted = focusAfter.current;
    if (wanted === null) return;
    focusAfter.current = null;
    const [id, by] = wanted.split(':');
    const first = document.querySelector<HTMLButtonElement>(`[data-move="${id}:${by}"]`);
    const other = document.querySelector<HTMLButtonElement>(
      `[data-move="${id}:${by === '1' ? '-1' : '1'}"]`,
    );
    (first !== null && !first.disabled ? first : other)?.focus();
  }, [page]);

  async function write(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await command.run(method, path, body);
    if (result === null) return false;
    if (!result.ok) {
      // The page changed under the editor: the dialog closes and the banner offers the reload.
      if (STALE_CODES.has(result.problem.code)) {
        setEditing(null);
        setRemoving(null);
      }
      return false;
    }
    setPage(result.page);
    setSaved(true);
    return true;
  }

  function move(slot: string, placements: readonly Placement[], index: number, by: -1 | 1) {
    const placement = placements[index];
    if (placement === undefined) return;
    focusAfter.current = `${placement.id}:${by}`;
    const order = moved(
      placements.map((entry) => entry.id),
      index,
      by,
    );
    void write('PUT', slotOrderPath(ref, slot), { placementIds: order });
  }

  async function save(config: Record<string, unknown>) {
    if (editing === null) return;
    const done =
      editing.placement === null
        ? await write('POST', slotModulesPath(ref, editing.slot), {
            module: editing.module,
            config,
          })
        : await write('PUT', modulePath(ref, editing.slot, editing.placement.id), { config });
    if (done) setEditing(null);
  }

  async function remove() {
    if (removing === null) return;
    const done = await write('DELETE', modulePath(ref, removing.slot, removing.placement.id));
    if (done) setRemoving(null);
  }

  const stale = command.problem !== null && STALE_CODES.has(command.problem.code);
  // A refusal of a dialog is shown in it; the rest are shown above the slots.
  const dialogOpen = editing !== null || removing !== null;
  const problem = command.problem;

  return (
    <div className="flex flex-col gap-4">
      <PageEditorHeader
        page={page}
        tab="content"
        zone={zone}
        canEdit={canEdit}
        actions={
          <PageActions
            page={page}
            canPublish={canPublish}
            canArchive={canArchive}
            csrfToken={csrfToken}
          />
        }
      />
      {!dialogOpen && problem !== null ? (
        <Banner tone="critical">
          <span>{problemText(problem)}</span>
          {stale ? (
            <>
              {' '}
              <Button variant="link" onClick={() => router.refresh()}>
                {t('reload')}
              </Button>
            </>
          ) : null}
        </Banner>
      ) : null}
      <p role="status" className="sr-only" aria-live="polite">
        {saved ? t('saved') : ''}
      </p>
      {page.kind === 'system' ? (
        <p className="rounded-md border border-dashed border-line px-3 py-2 text-sm text-fg-muted">
          {t('locked-row')}
        </p>
      ) : null}
      <div className="flex flex-col gap-4">
        {page.slots.map((slot) => (
          <SlotCard
            key={slot.key}
            slot={slot}
            label={slotNames.has(slot.key) ? slotNames(slot.key) : slot.key}
            placements={page.draft.placements[slot.key] ?? []}
            moduleName={moduleName}
            editable={!readOnly}
            busy={command.pending}
            onAdd={(module) => {
              command.reset();
              setEditing({ slot: slot.key, module, placement: null });
            }}
            onMove={(index, by) => move(slot.key, page.draft.placements[slot.key] ?? [], index, by)}
            onToggle={(placement) =>
              void write('PUT', modulePath(ref, slot.key, placement.id), {
                enabled: !placement.enabled,
              })
            }
            onEdit={(placement) => {
              command.reset();
              setEditing({ slot: slot.key, module: placement.module, placement });
            }}
            onRemove={(placement) => {
              command.reset();
              setRemoving({ slot: slot.key, placement });
            }}
          />
        ))}
      </div>
      {editing === null ? null : (
        <ModuleEditDialog
          // A new key per module, so each starts from its own settings.
          key={`${editing.slot}:${editing.placement?.id ?? editing.module}`}
          module={editing.module}
          name={moduleName(editing.module)}
          initial={editing.placement?.config ?? null}
          problem={problem}
          pending={command.pending}
          onSave={(config) => void save(config)}
          onClose={() => {
            command.reset();
            setEditing(null);
          }}
        />
      )}
      {removing === null ? null : (
        <Dialog
          open
          title={t('remove-title', { name: moduleName(removing.placement.module) })}
          onClose={() => {
            command.reset();
            setRemoving(null);
          }}
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  command.reset();
                  setRemoving(null);
                }}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="destructive-solid"
                loading={command.pending}
                onClick={() => void remove()}
              >
                {t('remove')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {problem === null ? null : <Banner tone="critical">{problemText(problem)}</Banner>}
            <p>{t('remove-body')}</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function SlotCard({
  slot,
  label,
  placements,
  moduleName,
  editable,
  busy,
  onAdd,
  onMove,
  onToggle,
  onEdit,
  onRemove,
}: {
  readonly slot: SlotDefinition;
  readonly label: string;
  readonly placements: readonly Placement[];
  readonly moduleName: (key: string) => string;
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onAdd: (module: string) => void;
  readonly onMove: (index: number, by: -1 | 1) => void;
  readonly onToggle: (placement: Placement) => void;
  readonly onEdit: (placement: Placement) => void;
  readonly onRemove: (placement: Placement) => void;
}) {
  const t = useTranslations('content.pages.editor');
  const fixed = slot.kind === 'fixed';
  const full = placements.length >= slot.max;
  const addable = slot.modules.filter(isEditableModule);
  return (
    <section
      aria-label={label}
      className={`flex min-w-0 flex-col gap-3 rounded-lg border bg-surface p-4 ${
        fixed ? 'border-dashed border-line' : 'border-line'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{label}</h2>
          <p className="text-sm text-fg-muted">
            {fixed
              ? t('slot-fixed')
              : slot.min > 0
                ? t('slot-count-min', { count: placements.length, max: slot.max, min: slot.min })
                : t('slot-count', { count: placements.length, max: slot.max })}
          </p>
        </div>
        {editable && !fixed && addable.length > 0 ? (
          <ActionMenu
            label={t('add-module')}
            disabled={full || busy}
            {...(full ? { hint: t('slot-full', { max: slot.max }) } : {})}
            items={addable.map((module) => ({
              id: module,
              label: moduleName(module),
              onSelect: () => onAdd(module),
            }))}
          />
        ) : null}
      </div>
      {fixed ? null : placements.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('slot-empty')}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {placements.map((placement, index) => (
            <ModuleRow
              key={placement.id}
              placement={placement}
              index={index}
              count={placements.length}
              min={slot.min}
              editable={editable}
              busy={busy}
              onMove={(by) => onMove(index, by)}
              onToggle={() => onToggle(placement)}
              onEdit={() => onEdit(placement)}
              onRemove={() => onRemove(placement)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
