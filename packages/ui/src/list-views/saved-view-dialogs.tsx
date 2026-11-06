'use client';

import { useEffect, useState } from 'react';
import { Badge } from '../form/badge.tsx';
import { Banner } from '../form/banner.tsx';
import { Button } from '../form/button.tsx';
import { EmptyState } from '../form/empty-state.tsx';
import { RadioGroup } from '../form/radio-group.tsx';
import { TextField } from '../form/text-field.tsx';
import { Dialog } from '../overlay/dialog.tsx';

// The two dialogs of the saved views of a list (Figma "Save filter" and "Manage filters"), written
// once for every list. They hold no request: the list passes async handlers that answer with the
// problem to show (or null) and says every word through `labels`.

/** What a refused save, rename or delete says; the list maps its API's refusals onto these. */
export type SavedViewProblem =
  'name-taken' | 'name-empty' | 'limit' | 'shared-limit' | 'denied' | 'unavailable';

export type SavedViewVisibility = 'me' | 'everyone';

export interface SavedViewLabels {
  readonly cancel: string;
  readonly visibility: { readonly me: string; readonly everyone: string };
  readonly save: {
    readonly title: string;
    readonly submit: string;
    readonly name: string;
    readonly who: string;
    readonly everyoneHelp: string;
    readonly ownOnly: string;
  };
  readonly manage: {
    readonly title: string;
    readonly close: string;
    readonly empty: string;
    readonly emptyHelp: string;
    readonly helpShare: string;
    readonly helpOwn: string;
    readonly sharedByOther: string;
    readonly edit: string;
    readonly delete: string;
    readonly save: string;
    readonly deleteConfirm: string;
    readonly editNamed: (name: string) => string;
    readonly deleteNamed: (name: string) => string;
    readonly deleteOwn: (name: string) => string;
    readonly deleteShared: (name: string) => string;
  };
  readonly error: (problem: SavedViewProblem) => string;
}

export interface SavedViewItem {
  readonly id: string;
  readonly name: string;
  readonly visibility: SavedViewVisibility;
  readonly ownedByMe: boolean;
  readonly canManage: boolean;
}

export const SAVED_VIEW_NAME_MAX = 60;

const isNameProblem = (problem: SavedViewProblem | null): problem is 'name-taken' | 'name-empty' =>
  problem === 'name-taken' || problem === 'name-empty';

/**
 * The Save filter dialog: a name and who can use the filter, over a one-line summary of what is
 * saved. A list that can share lets the person choose Only me or Everyone; otherwise the filter is
 * saved for them only. Enter saves; a name that is empty, repeated or too long is said under the
 * field, any other refusal in a banner.
 */
export function SaveViewDialog({
  open,
  onClose,
  summary,
  canShare,
  labels,
  idPrefix,
  onSave,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** What the filter holds, in words. */
  readonly summary: string;
  readonly canShare: boolean;
  readonly labels: SavedViewLabels;
  /** Keeps the ids of the form and of the radio group apart from another list's. */
  readonly idPrefix: string;
  /** Saves; resolves to the problem to show, or null when it is saved (the dialog closes). */
  readonly onSave: (
    name: string,
    visibility: SavedViewVisibility,
  ) => Promise<SavedViewProblem | null>;
}) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<SavedViewVisibility>('me');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SavedViewProblem | null>(null);

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
    const refused = await onSave(name.trim(), canShare ? visibility : 'me');
    setBusy(false);
    if (refused !== null) setProblem(refused);
    else onClose();
  }

  const nameProblem = isNameProblem(problem) ? problem : null;
  const banner = problem !== null && nameProblem === null ? problem : null;
  const formId = `${idPrefix}-save-filter`;

  return (
    <Dialog
      open={open}
      title={labels.save.title}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {labels.save.submit}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-sm text-fg-secondary [overflow-wrap:anywhere]">{summary}</p>
        {banner === null ? null : <Banner tone="critical">{labels.error(banner)}</Banner>}
        <TextField
          label={labels.save.name}
          value={name}
          maxLength={SAVED_VIEW_NAME_MAX}
          autoComplete="off"
          error={nameProblem === null ? undefined : labels.error(nameProblem)}
          onChange={(event) => {
            setName(event.target.value);
            if (nameProblem !== null) setProblem(null);
          }}
        />
        {canShare ? (
          <RadioGroup
            legend={labels.save.who}
            name={`${idPrefix}-saved-visibility`}
            value={visibility}
            disabled={busy}
            options={[
              { value: 'me', label: labels.visibility.me },
              {
                value: 'everyone',
                label: labels.visibility.everyone,
                help: labels.save.everyoneHelp,
              },
            ]}
            onChange={(value) => setVisibility(value as SavedViewVisibility)}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-fg">{labels.save.who}</p>
            <p className="text-sm text-fg-muted">{labels.save.ownOnly}</p>
          </div>
        )}
      </form>
    </Dialog>
  );
}

type Mode = { readonly kind: 'edit' | 'delete'; readonly id: string } | null;

function Row({
  view,
  canShare,
  labels,
  idPrefix,
  mode,
  onMode,
  onRename,
  onDelete,
}: {
  readonly view: SavedViewItem;
  readonly canShare: boolean;
  readonly labels: SavedViewLabels;
  readonly idPrefix: string;
  readonly mode: Mode;
  readonly onMode: (next: Mode) => void;
  readonly onRename: (
    id: string,
    name: string,
    visibility: SavedViewVisibility,
  ) => Promise<SavedViewProblem | null>;
  readonly onDelete: (id: string) => Promise<SavedViewProblem | null>;
}) {
  const [name, setName] = useState(view.name);
  const [visibility, setVisibility] = useState<SavedViewVisibility>(view.visibility);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SavedViewProblem | null>(null);
  const editing = mode?.id === view.id && mode.kind === 'edit';
  const deleting = mode?.id === view.id && mode.kind === 'delete';

  useEffect(() => {
    setName(view.name);
    setVisibility(view.visibility);
    setProblem(null);
  }, [view.name, view.visibility, mode]);

  async function save() {
    if (name.trim() === '') {
      setProblem('name-empty');
      return;
    }
    setBusy(true);
    setProblem(null);
    const refused = await onRename(view.id, name.trim(), visibility);
    setBusy(false);
    if (refused !== null) setProblem(refused);
    else onMode(null);
  }

  async function remove() {
    setBusy(true);
    setProblem(null);
    const refused = await onDelete(view.id);
    setBusy(false);
    if (refused !== null) setProblem(refused);
    else onMode(null);
  }

  const nameProblem = isNameProblem(problem) ? problem : null;
  const banner = problem !== null && nameProblem === null ? problem : null;
  const mayShare = canShare || view.visibility === 'everyone';

  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium text-fg [overflow-wrap:anywhere]">{view.name}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Badge tone={view.visibility === 'everyone' ? 'info' : 'neutral'}>
              {labels.visibility[view.visibility]}
            </Badge>
            {view.ownedByMe ? null : <span>{labels.manage.sharedByOther}</span>}
          </div>
        </div>
        {view.canManage && !editing && !deleting ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              aria-label={labels.manage.editNamed(view.name)}
              onClick={() => onMode({ kind: 'edit', id: view.id })}
            >
              {labels.manage.edit}
            </Button>
            <Button
              variant="destructive"
              aria-label={labels.manage.deleteNamed(view.name)}
              onClick={() => onMode({ kind: 'delete', id: view.id })}
            >
              {labels.manage.delete}
            </Button>
          </div>
        ) : null}
      </div>
      {banner === null ? null : <Banner tone="critical">{labels.error(banner)}</Banner>}
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
            label={labels.save.name}
            value={name}
            maxLength={SAVED_VIEW_NAME_MAX}
            autoComplete="off"
            error={nameProblem === null ? undefined : labels.error(nameProblem)}
            onChange={(event) => {
              setName(event.target.value);
              if (nameProblem !== null) setProblem(null);
            }}
          />
          {mayShare ? (
            <RadioGroup
              legend={labels.save.who}
              name={`${idPrefix}-saved-visibility-${view.id}`}
              value={visibility}
              disabled={busy}
              options={[
                { value: 'me', label: labels.visibility.me },
                {
                  value: 'everyone',
                  label: labels.visibility.everyone,
                  help: labels.save.everyoneHelp,
                  disabled: !canShare && view.visibility !== 'everyone',
                },
              ]}
              onChange={(value) => setVisibility(value as SavedViewVisibility)}
            />
          ) : (
            <p className="text-sm text-fg-muted">{labels.save.ownOnly}</p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onMode(null)}>
              {labels.cancel}
            </Button>
            <Button type="submit" loading={busy}>
              {labels.manage.save}
            </Button>
          </div>
        </form>
      ) : null}
      {deleting ? (
        <div
          role="group"
          aria-label={labels.manage.deleteNamed(view.name)}
          className="flex flex-col gap-3 rounded-md border border-critical-border bg-critical-bg p-3"
        >
          <p className="text-sm text-fg [overflow-wrap:anywhere]">
            {view.visibility === 'everyone'
              ? labels.manage.deleteShared(view.name)
              : labels.manage.deleteOwn(view.name)}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onMode(null)}>
              {labels.cancel}
            </Button>
            <Button variant="destructive" loading={busy} onClick={() => void remove()}>
              {labels.manage.deleteConfirm}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The Manage filters dialog: every saved view the person can see, with rename, who can use it and
 * delete for the ones they may manage. Reordering is not offered. A delete of a filter that is
 * already gone should resolve to null: it is what the person wanted.
 */
export function ManageViewsDialog({
  open,
  onClose,
  views,
  canShare,
  labels,
  idPrefix,
  onRename,
  onDelete,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly views: readonly SavedViewItem[];
  readonly canShare: boolean;
  readonly labels: SavedViewLabels;
  readonly idPrefix: string;
  readonly onRename: (
    id: string,
    name: string,
    visibility: SavedViewVisibility,
  ) => Promise<SavedViewProblem | null>;
  readonly onDelete: (id: string) => Promise<SavedViewProblem | null>;
}) {
  const [mode, setMode] = useState<Mode>(null);

  useEffect(() => {
    if (!open) setMode(null);
  }, [open]);

  return (
    <Dialog
      open={open}
      title={labels.manage.title}
      onClose={onClose}
      actions={
        <Button variant="secondary" onClick={onClose}>
          {labels.manage.close}
        </Button>
      }
    >
      {views.length === 0 ? (
        <EmptyState
          size="compact"
          icon="sliders"
          title={labels.manage.empty}
          body={labels.manage.emptyHelp}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-muted">
            {canShare ? labels.manage.helpShare : labels.manage.helpOwn}
          </p>
          <ul className="divide-y divide-line">
            {views.map((view) => (
              <Row
                key={view.id}
                view={view}
                canShare={canShare}
                labels={labels}
                idPrefix={idPrefix}
                mode={mode}
                onMode={setMode}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
