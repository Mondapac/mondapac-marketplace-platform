'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge } from '../form/badge.tsx';
import { Banner } from '../form/banner.tsx';
import { EmptyState } from '../form/empty-state.tsx';
import { Button } from '../form/button.tsx';
import { RadioGroup } from '../form/radio-group.tsx';
import { TextField } from '../form/text-field.tsx';
import { Dialog } from '../overlay/dialog.tsx';
import { Icon } from '../icon/icon.tsx';

// The two dialogs of a list's saved filters (Figma "Save filter" and "Manage filters"), shared by
// the admin and the seller Products lists. They hold no text and make no request: the page
// passes its words and one function per action, which answers null when it worked and otherwise
// the problem to show.

export type SavedFilterVisibility = 'me' | 'everyone';

/** Why a save, a rename or a delete was refused, as the dialogs word it (one text per cause). */
export type SavedFilterProblem =
  | 'name-taken'
  | 'name-empty'
  | 'limit'
  | 'shared-limit'
  | 'denied'
  /** A session that may not write (a seller logged in as by staff). */
  | 'acting-as'
  /** The filter is gone (another member deleted it). */
  | 'not-found'
  | 'unavailable';

export const SAVED_FILTER_NAME_MAX = 60;

/** The words both dialogs share: the name and visibility fields and one text per problem. */
export interface SavedFilterFieldLabels {
  readonly name: string;
  readonly who: string;
  readonly me: string;
  readonly everyone: string;
  readonly everyoneHelp: string;
  /** Shown instead of the choice when the role cannot share. */
  readonly ownOnly: string;
  readonly cancel: string;
  readonly errors: Readonly<Record<SavedFilterProblem, string>>;
}

export interface SaveFilterLabels extends SavedFilterFieldLabels {
  readonly title: string;
  readonly submit: string;
}

export interface SaveFilterDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** What the filter holds, in words: the tab, the search and each condition. */
  readonly summary: string;
  readonly canShare: boolean;
  readonly labels: SaveFilterLabels;
  /** Saves; null when it worked (the dialog closes), else the problem to show. */
  readonly onSubmit: (input: {
    readonly name: string;
    readonly visibility: SavedFilterVisibility;
  }) => Promise<SavedFilterProblem | null>;
}

const isNameProblem = (
  problem: SavedFilterProblem | null,
): problem is 'name-taken' | 'name-empty' => problem === 'name-taken' || problem === 'name-empty';

/**
 * The Save filter dialog: a name and who can use the filter, over a one-line summary of what is
 * saved. A role that may share chooses Only me or Everyone; any other sees that the filter is
 * saved for them only. Enter saves; a name that is empty or repeated is said under the field, any
 * other refusal in a banner.
 */
export function SaveFilterDialog({
  open,
  onClose,
  summary,
  canShare,
  labels,
  onSubmit,
}: SaveFilterDialogProps) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<SavedFilterVisibility>('me');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SavedFilterProblem | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setVisibility('me');
    setBusy(false);
    setProblem(null);
  }, [open]);

  async function save() {
    if (busy) return;
    if (name.trim() === '') {
      setProblem('name-empty');
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await onSubmit({
      name: name.trim(),
      visibility: canShare ? visibility : 'me',
    });
    setBusy(false);
    if (result !== null) {
      setProblem(result);
      return;
    }
    onClose();
  }

  const nameProblem = isNameProblem(problem) ? problem : null;
  const banner = problem !== null && nameProblem === null ? problem : null;

  return (
    <Dialog
      open={open}
      title={labels.title}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button type="submit" form="list-save-filter" loading={busy}>
            {labels.submit}
          </Button>
        </>
      }
    >
      <form
        id="list-save-filter"
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-sm text-fg-secondary [overflow-wrap:anywhere]">{summary}</p>
        {banner === null ? null : <Banner tone="critical">{labels.errors[banner]}</Banner>}
        <TextField
          label={labels.name}
          value={name}
          maxLength={SAVED_FILTER_NAME_MAX}
          autoComplete="off"
          error={nameProblem === null ? undefined : labels.errors[nameProblem]}
          onChange={(event) => {
            setName(event.target.value);
            if (nameProblem !== null) setProblem(null);
          }}
        />
        {canShare ? (
          <RadioGroup
            legend={labels.who}
            name="list-saved-visibility"
            value={visibility}
            disabled={busy}
            options={[
              { value: 'me', label: labels.me },
              { value: 'everyone', label: labels.everyone, help: labels.everyoneHelp },
            ]}
            onChange={(value) => setVisibility(value as SavedFilterVisibility)}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-fg">{labels.who}</p>
            <p className="text-sm text-fg-muted">{labels.ownOnly}</p>
          </div>
        )}
      </form>
    </Dialog>
  );
}

/** One saved filter as the Manage dialog lists it. */
export interface ManagedFilter {
  readonly id: string;
  readonly name: string;
  readonly visibility: SavedFilterVisibility;
  readonly ownedByMe: boolean;
  readonly canManage: boolean;
}

export interface ManageFiltersLabels extends SavedFilterFieldLabels {
  readonly title: string;
  readonly close: string;
  readonly edit: string;
  readonly editNamed: (name: string) => string;
  readonly delete: string;
  readonly deleteNamed: (name: string) => string;
  readonly deleteConfirm: string;
  readonly deleteOwn: (name: string) => string;
  readonly deleteShared: (name: string) => string;
  readonly save: string;
  readonly sharedByOther: string;
  readonly empty: string;
  readonly emptyHelp: string;
  readonly helpShare: string;
  readonly helpOwn: string;
  /** Reordering (only with `onReorder`): the buttons that move an own filter up or down. */
  readonly moveUp?: (name: string) => string;
  readonly moveDown?: (name: string) => string;
}

export interface ManageFiltersDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly filters: readonly ManagedFilter[];
  readonly canShare: boolean;
  readonly labels: ManageFiltersLabels;
  /** Renames and sets who can use a filter; null when it worked, else the problem to show. */
  readonly onUpdate: (
    id: string,
    input: { readonly name: string; readonly visibility: SavedFilterVisibility },
  ) => Promise<SavedFilterProblem | null>;
  /** Deletes a filter; null when it worked (or it was already gone), else the problem to show. */
  readonly onDelete: (id: string) => Promise<SavedFilterProblem | null>;
  /**
   * Saves a new order of the viewer's own filters (all their ids, in order) after `movedId` moved
   * one place; null when it worked, else the problem to show. Without it, no move buttons.
   */
  readonly onReorder?: (
    ids: readonly string[],
    movedId: string,
  ) => Promise<SavedFilterProblem | null>;
}

type Mode = { readonly kind: 'edit' | 'delete'; readonly id: string } | null;

/**
 * One saved filter in the Manage filters list: its name and who can use it, and, when the viewer
 * may manage it, Edit (name and, if the role can share, who can use it) and Delete (asked once, in
 * the row). A filter somebody else shared, which this role cannot manage, is listed without
 * actions and says it is theirs.
 */
function Row({
  filter,
  canShare,
  labels,
  mode,
  onMode,
  onUpdate,
  onDelete,
  move,
}: {
  /** Moves this filter one place (own filters only); null when it cannot move that way. */
  readonly move?: {
    readonly up: (() => void) | null;
    readonly down: (() => void) | null;
    readonly busy: boolean;
  };
  readonly filter: ManagedFilter;
  readonly canShare: boolean;
  readonly labels: ManageFiltersLabels;
  readonly mode: Mode;
  readonly onMode: (next: Mode) => void;
  readonly onUpdate: ManageFiltersDialogProps['onUpdate'];
  readonly onDelete: ManageFiltersDialogProps['onDelete'];
}) {
  const [name, setName] = useState(filter.name);
  const [visibility, setVisibility] = useState<SavedFilterVisibility>(filter.visibility);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SavedFilterProblem | null>(null);
  const editing = mode?.id === filter.id && mode.kind === 'edit';
  const deleting = mode?.id === filter.id && mode.kind === 'delete';

  useEffect(() => {
    setName(filter.name);
    setVisibility(filter.visibility);
    setProblem(null);
  }, [filter.name, filter.visibility, mode]);

  async function save() {
    if (name.trim() === '') {
      setProblem('name-empty');
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await onUpdate(filter.id, { name: name.trim(), visibility });
    setBusy(false);
    if (result !== null) {
      setProblem(result);
      return;
    }
    onMode(null);
  }

  async function remove() {
    setBusy(true);
    setProblem(null);
    const result = await onDelete(filter.id);
    setBusy(false);
    if (result !== null) {
      setProblem(result);
      return;
    }
    onMode(null);
  }

  const nameProblem = isNameProblem(problem) ? problem : null;
  const banner = problem !== null && nameProblem === null ? problem : null;
  const mayShare = canShare || filter.visibility === 'everyone';

  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium text-fg [overflow-wrap:anywhere]">{filter.name}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Badge tone={filter.visibility === 'everyone' ? 'info' : 'neutral'}>
              {filter.visibility === 'everyone' ? labels.everyone : labels.me}
            </Badge>
            {filter.ownedByMe ? null : <span>{labels.sharedByOther}</span>}
          </div>
        </div>
        {filter.canManage && !editing && !deleting ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {move === undefined ||
            labels.moveUp === undefined ||
            labels.moveDown === undefined ? null : (
              <>
                <Button
                  variant="secondary"
                  aria-label={labels.moveUp(filter.name)}
                  title={labels.moveUp(filter.name)}
                  data-move={`${filter.id}:up`}
                  disabled={move.up === null || move.busy}
                  onClick={() => move.up?.()}
                >
                  <Icon name="chevron-up" />
                </Button>
                <Button
                  variant="secondary"
                  aria-label={labels.moveDown(filter.name)}
                  title={labels.moveDown(filter.name)}
                  data-move={`${filter.id}:down`}
                  disabled={move.down === null || move.busy}
                  onClick={() => move.down?.()}
                >
                  <Icon name="chevron-down" />
                </Button>
              </>
            )}
            <Button
              variant="secondary"
              aria-label={labels.editNamed(filter.name)}
              onClick={() => onMode({ kind: 'edit', id: filter.id })}
            >
              {labels.edit}
            </Button>
            <Button
              variant="destructive"
              aria-label={labels.deleteNamed(filter.name)}
              onClick={() => onMode({ kind: 'delete', id: filter.id })}
            >
              {labels.delete}
            </Button>
          </div>
        ) : null}
      </div>
      {banner === null ? null : <Banner tone="critical">{labels.errors[banner]}</Banner>}
      {editing ? (
        <form
          className="flex flex-col gap-4 rounded-md border border-line bg-subtle p-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextField
            label={labels.name}
            value={name}
            maxLength={SAVED_FILTER_NAME_MAX}
            autoComplete="off"
            error={nameProblem === null ? undefined : labels.errors[nameProblem]}
            onChange={(event) => {
              setName(event.target.value);
              if (nameProblem !== null) setProblem(null);
            }}
          />
          {mayShare ? (
            <RadioGroup
              legend={labels.who}
              name={`list-saved-visibility-${filter.id}`}
              value={visibility}
              disabled={busy}
              options={[
                { value: 'me', label: labels.me },
                {
                  value: 'everyone',
                  label: labels.everyone,
                  help: labels.everyoneHelp,
                  disabled: !canShare && filter.visibility !== 'everyone',
                },
              ]}
              onChange={(value) => setVisibility(value as SavedFilterVisibility)}
            />
          ) : (
            <p className="text-sm text-fg-muted">{labels.ownOnly}</p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onMode(null)}>
              {labels.cancel}
            </Button>
            <Button type="submit" loading={busy}>
              {labels.save}
            </Button>
          </div>
        </form>
      ) : null}
      {deleting ? (
        <div
          role="group"
          aria-label={labels.deleteNamed(filter.name)}
          className="flex flex-col gap-3 rounded-md border border-critical-border bg-critical-bg p-3"
        >
          <p className="text-sm text-fg [overflow-wrap:anywhere]">
            {filter.visibility === 'everyone'
              ? labels.deleteShared(filter.name)
              : labels.deleteOwn(filter.name)}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onMode(null)}>
              {labels.cancel}
            </Button>
            <Button variant="destructive" loading={busy} onClick={() => void remove()}>
              {labels.deleteConfirm}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The Manage filters dialog: every saved filter the viewer can see, with rename, who can use it
 * and delete for the ones they may manage. Reordering is offered only when the page passes
 * `onReorder` (and the two move labels): the viewer's own filters get Move up and Move down, and
 * `onReorder` gets the ids of all their own filters in the new order.
 */
export function ManageFiltersDialog({
  open,
  onClose,
  filters,
  canShare,
  labels,
  onUpdate,
  onDelete,
  onReorder,
}: ManageFiltersDialogProps) {
  const [mode, setMode] = useState<Mode>(null);
  const [moving, setMoving] = useState(false);
  const [moveProblem, setMoveProblem] = useState<SavedFilterProblem | null>(null);
  const focusAfter = useRef<{ id: string; step: -1 | 1 } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) {
      setMode(null);
      setMoveProblem(null);
    }
  }, [open]);

  // After a move the viewer keeps their place: focus goes back to the button they used, or, when
  // the row has reached an end and that button is now disabled, to the row's other move button.
  useEffect(() => {
    const pending = focusAfter.current;
    if (pending === null) return;
    focusAfter.current = null;
    const find = (dir: string) =>
      listRef.current?.querySelector<HTMLButtonElement>(`[data-move="${pending.id}:${dir}"]`) ??
      null;
    const used = find(pending.step === -1 ? 'up' : 'down');
    const other = find(pending.step === -1 ? 'down' : 'up');
    (used !== null && !used.disabled ? used : other)?.focus();
  }, [filters]);

  const own = filters.filter((filter) => filter.ownedByMe).map((filter) => filter.id);
  async function moveBy(id: string, step: -1 | 1) {
    if (onReorder === undefined) return;
    const at = own.indexOf(id);
    const ids = [...own];
    ids.splice(at, 1);
    ids.splice(at + step, 0, id);
    setMoving(true);
    setMoveProblem(null);
    focusAfter.current = { id, step };
    const refused = await onReorder(ids, id);
    setMoving(false);
    if (refused !== null) {
      focusAfter.current = null;
      setMoveProblem(refused);
    }
  }

  return (
    <Dialog
      open={open}
      title={labels.title}
      onClose={onClose}
      actions={
        <Button variant="secondary" onClick={onClose}>
          {labels.close}
        </Button>
      }
    >
      {filters.length === 0 ? (
        <EmptyState size="compact" icon="sliders" title={labels.empty} body={labels.emptyHelp} />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-muted">{canShare ? labels.helpShare : labels.helpOwn}</p>
          {moveProblem === null ? null : (
            <Banner tone="critical">{labels.errors[moveProblem]}</Banner>
          )}
          <ul ref={listRef} className="divide-y divide-line">
            {filters.map((filter) => (
              <Row
                move={
                  onReorder === undefined || !filter.ownedByMe
                    ? undefined
                    : {
                        up: own.indexOf(filter.id) > 0 ? () => void moveBy(filter.id, -1) : null,
                        down:
                          own.indexOf(filter.id) < own.length - 1
                            ? () => void moveBy(filter.id, 1)
                            : null,
                        busy: moving,
                      }
                }
                key={filter.id}
                filter={filter}
                canShare={canShare}
                labels={labels}
                mode={mode}
                onMode={setMode}
                onUpdate={onUpdate}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
